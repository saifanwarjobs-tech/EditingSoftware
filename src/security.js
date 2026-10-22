import { createHash, timingSafeEqual } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest();

/** Constant-time check that `token` equals one of `tokens`. Returns the matching token or null. */
export function matchToken(token, tokens) {
  if (!token) return null;
  const t = sha(token);
  let found = null;
  for (const candidate of tokens) if (timingSafeEqual(t, sha(candidate))) found = candidate; // no early exit
  return found;
}

/** Stable, non-reversible id for a token (used to scope jobs to a user). */
export const ownerId = (token) => createHash("sha256").update("owner:" + token).digest("hex").slice(0, 16);

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** In-memory sliding-window rate limiter. */
export class RateLimiter {
  constructor() { this.hits = new Map(); }
  /** @returns {{ok:boolean, retryAfterSec:number}} */
  hit(key, limit, windowMs, now = Date.now()) {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.ceil((arr[0] + windowMs - now) / 1000) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true, retryAfterSec: 0 };
  }
  prune(windowMs = 3600_000, now = Date.now()) {
    for (const [k, arr] of this.hits) {
      const live = arr.filter((t) => now - t < windowMs);
      live.length ? this.hits.set(k, live) : this.hits.delete(k);
    }
  }
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress ?? "unknown";
}
