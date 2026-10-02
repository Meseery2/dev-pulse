import { createHash, createHmac } from "node:crypto";

/**
 * Contributor identities are stored as salted hashes. The product never
 * displays an individual, so there is no reason to retain a reversible
 * identifier. A per-deployment salt means the hashes are not comparable across
 * installations either.
 */
export function hashIdentity(login: string): string {
  const salt = process.env.IDENTITY_SALT ?? "epd-local-development-salt";
  return createHmac("sha256", salt).update(login.toLowerCase()).digest("hex").slice(0, 32);
}

export function stableId(...parts: (string | number | null | undefined)[]): string {
  return createHash("sha1").update(parts.map((p) => String(p ?? "")).join("\u0000")).digest("hex").slice(0, 32);
}

const BOT_PATTERN = /\[bot\]$|-bot$|^dependabot|^github-actions|^renovate|^copilot$/i;

export function looksLikeBot(login: string | null | undefined, type?: string | null): boolean {
  if (type && type.toLowerCase() === "bot") return true;
  if (!login) return false;
  return BOT_PATTERN.test(login);
}
