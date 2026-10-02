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
}

export class GitHubClient {
  private readonly token?: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  readonly budget: RequestBudget;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.budget = options.budget;
    this.userAgent = options.userAgent ?? "engineering-productivity-dashboard";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  async request<T>(path: string, etag?: string | null): Promise<GitHubResponse<T>> {
    const url = path.startsWith("http") ? path : `${API_ROOT}${path}`;
    this.budget.consume();

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.userAgent,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (etag) headers["If-None-Match"] = etag;

    const response = await this.fetchImpl(url, { headers, cache: "no-store" });

    if (response.status === 304) {
      return { data: [] as unknown as T, etag: etag ?? null, notModified: true, nextUrl: null };
    }

    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0" || response.headers.get("retry-after")) {
        const resetHeader = response.headers.get("x-ratelimit-reset");
        const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : null;
        throw new RateLimitError(
          `GitHub rate limit reached${resetAt ? `, resets at ${resetAt.toISOString()}` : ""}`,
          resetAt,
        );
      }
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
    } = {},
  ): Promise<{ items: T[]; etag: string | null; notModified: boolean; truncated: boolean }> {
    const maxPages = options.maxPages ?? 1;
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

      const response: GitHubResponse<T[]> = await this.request<T[]>(
        url,
        pages === 0 ? options.etag : undefined,
      );
      if (pages === 0) {
        firstEtag = response.etag;
        if (response.notModified) {
          return { items: [], etag: firstEtag, notModified: true, truncated: false };
        }
      }

      const page = Array.isArray(response.data) ? response.data : [];
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
