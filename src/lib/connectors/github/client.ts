export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly resetAt: Date | null,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export interface GitHubResponse<T> {
  data: T;
  etag: string | null;
  /** True when the server answered 304 and `data` should be treated as unchanged. */
  notModified: boolean;
  nextUrl: string | null;
}

/**
 * Caps how many API calls a single sync may spend. Unauthenticated GitHub
 * allows 60 requests/hour, which is a hard design constraint rather than an
 * edge case: the connector must be able to stop cleanly mid-backfill and
 * resume on the next run without losing or duplicating work.
 */
export class RequestBudget {
  private spent = 0;

  constructor(private readonly limit: number) {}

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  get used(): number {
    return this.spent;
  }

  consume(): void {
    if (this.remaining <= 0) {
      throw new BudgetExhaustedError(`request budget of ${this.limit} exhausted`);
    }
    this.spent += 1;
  }

  canAfford(count: number): boolean {
    return this.remaining >= count;
  }
}

const API_ROOT = "https://api.github.com";

export interface GitHubClientOptions {
  token?: string;
  budget: RequestBudget;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  /** Minimum gap between requests, to stay under GitHub's secondary rate limits. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GitHubClient {
  private readonly token?: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private lastRequestAt = 0;
  readonly budget: RequestBudget;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.budget = options.budget;
    this.userAgent = options.userAgent ?? "engineering-productivity-dashboard";
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Unauthenticated traffic trips GitHub's burst protection quickly, so it
    // is paced more conservatively than token traffic.
    this.minIntervalMs = options.minIntervalMs ?? (options.token ? 150 : 900);
    this.maxRetries = options.maxRetries ?? 3;
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && elapsed < this.minIntervalMs) {
      await this.sleepImpl(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  async request<T>(path: string, etag?: string | null): Promise<GitHubResponse<T>> {
    const url = path.startsWith("http") ? path : `${API_ROOT}${path}`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.userAgent,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (etag) headers["If-None-Match"] = etag;

    for (let attempt = 0; ; attempt += 1) {
      this.budget.consume();
      await this.pace();
      const response = await this.fetchImpl(url, { headers, cache: "no-store" });

      if (response.status === 304) {
        return { data: [] as unknown as T, etag: etag ?? null, notModified: true, nextUrl: null };
      }

      if (response.status === 403 || response.status === 429) {
        const body = await response.text();
        const remaining = response.headers.get("x-ratelimit-remaining");
        const retryAfter = response.headers.get("retry-after");

        // The primary hourly quota is exhausted: no amount of waiting inside
        // this run will help, so stop and let the next run resume.
        if (remaining === "0") {
          const resetHeader = response.headers.get("x-ratelimit-reset");
          const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : null;
          throw new RateLimitError(
            `GitHub hourly rate limit reached${resetAt ? `, resets at ${resetAt.toISOString()}` : ""}`,
            resetAt,
          );
        }

        // A secondary rate limit is a burst-protection signal and clears after
        // a short wait, so it is worth retrying with backoff.
        const isSecondary = /secondary rate limit/i.test(body) || Boolean(retryAfter);
        if (isSecondary && attempt < this.maxRetries && this.budget.remaining > 0) {
          const waitMs = retryAfter ? Number(retryAfter) * 1000 : 2 ** attempt * 2000;
          await this.sleepImpl(waitMs);
          continue;
        }

        throw new RateLimitError(
          `GitHub rejected the request with a rate limit after ${attempt + 1} attempt(s)`,
          null,
        );
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub ${response.status} for ${url}: ${body.slice(0, 200)}`);
      }

      return {
        data: (await response.json()) as T,
        etag: response.headers.get("etag"),
        notModified: false,
        nextUrl: parseNextLink(response.headers.get("link")),
      };
    }
  }

  /**
   * Walks pages until `maxPages`, the budget runs out, or `shouldStop` says the
   * remaining pages are older than the watermark. Stopping early is normal and
   * is not an error.
   */
  async paginate<T>(
    path: string,
    options: {
      maxPages?: number;
      etag?: string | null;
      shouldStop?: (page: T[]) => boolean;
      /** Some endpoints (notably Actions) wrap results in an envelope object. */
      extract?: (data: unknown) => T[];
    } = {},
  ): Promise<{ items: T[]; etag: string | null; notModified: boolean; truncated: boolean }> {
    const maxPages = options.maxPages ?? 1;
    const extract =
      options.extract ?? ((data: unknown) => (Array.isArray(data) ? (data as T[]) : []));
    const items: T[] = [];
    let url: string | null = path;
    let firstEtag: string | null = null;
    let pages = 0;
    let truncated = false;

    while (url && pages < maxPages) {
      if (this.budget.remaining <= 0) {
        truncated = true;
        break;
      }

      const response: GitHubResponse<unknown> = await this.request<unknown>(
        url,
        pages === 0 ? options.etag : undefined,
      );
      if (pages === 0) {
        firstEtag = response.etag;
        if (response.notModified) {
          return { items: [], etag: firstEtag, notModified: true, truncated: false };
        }
      }

      const page = extract(response.data);
      items.push(...page);
      pages += 1;

      if (options.shouldStop?.(page)) break;
      url = response.nextUrl;
      if (url && pages >= maxPages) truncated = true;
    }

    return { items, etag: firstEtag, notModified: false, truncated };
  }
}

export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}
