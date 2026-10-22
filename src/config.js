import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch { /* ignore malformed .env */ }
}

const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3000),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024,
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  captionFont: process.env.CAPTION_FONT || "Arial",
  captionFontSize: Number(process.env.CAPTION_FONT_SIZE || 18),
  dataDir: resolve(process.env.DATA_DIR || "data"),
  musicDir: resolve(process.cwd(), "assets/music"),

  // --- access control & limits ---
  // Comma-separated secret tokens. Each token is one "user"; users only see their own jobs.
  // Empty = open access (fine for local use, NOT for a public website).
  accessTokens: list(process.env.ACCESS_TOKENS),
  rateLimitPerHour: Number(process.env.RATE_LIMIT_PER_HOUR || 10), // uploads per user (or per IP when open) per hour
  maxQueue: Number(process.env.MAX_QUEUE || 20),                   // queued + processing jobs
  retentionHours: Number(process.env.RETENTION_HOURS || 24),       // finished jobs are deleted after this
  maxVideoMinutes: Number(process.env.MAX_VIDEO_MINUTES || 30),    // longest accepted video
  trustProxy: process.env.TRUST_PROXY === "1",                     // set behind nginx/Cloudflare so real client IP is used
  secureCookies: process.env.SECURE_COOKIES === "1",               // set when served over HTTPS
};
