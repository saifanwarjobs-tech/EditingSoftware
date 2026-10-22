import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch { /* ignore malformed .env */ }
}

export const config = {
  port: Number(process.env.PORT || 3000),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024,
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  captionFont: process.env.CAPTION_FONT || "Arial",
  captionFontSize: Number(process.env.CAPTION_FONT_SIZE || 18),
  dataDir: resolve(process.cwd(), "data"),
};
