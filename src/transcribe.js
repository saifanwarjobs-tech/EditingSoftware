// Step 1: speech -> word-level timestamps, using the HyperFrames CLI (Whisper/Parakeet).
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Normalise any supported transcript JSON shape into [{id,text,start,end}]. */
export function normalizeWords(raw) {
  const arr = Array.isArray(raw) ? raw : raw?.words ?? raw?.segments?.flatMap((s) => s.words ?? []) ?? [];
  const words = arr
    .map((w) => ({
      text: String(w.text ?? w.word ?? "").trim(),
      start: Number(w.start),
      end: Number(w.end),
    }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  words.sort((a, b) => a.start - b.start);
  return words.map((w, i) => ({ id: i, ...w }));
}

export async function loadTranscriptFile(path) {
  return normalizeWords(JSON.parse(await readFile(path, "utf8")));
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`))));
  });
}

/**
 * Transcribe a video via `npx hyperframes transcribe`.
 * The CLI writes transcript.json into --dir.
 */
export async function transcribe(videoPath, workDir, { language } = {}) {
  const args = ["--yes", "hyperframes", "transcribe", videoPath, "--dir", workDir, "--json"];
  if (language) args.push("--language", language);
  await run("npx", args, { cwd: workDir });
  return loadTranscriptFile(join(workDir, "transcript.json"));
}
