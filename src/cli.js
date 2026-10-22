#!/usr/bin/env node
// Usage: node src/cli.js input.mp4 [--strength light|medium|aggressive] [--smart] [--no-captions] [--no-audio] [--lufs -14] [--music track.mp3] [--lang hi] [--transcript t.json] [--out dir]
import { resolve, basename } from "node:path";
import { processVideo } from "./pipeline.js";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
if (!input) {
  console.error("Usage: node src/cli.js <video> [--strength medium] [--smart] [--no-captions] [--no-audio] [--lufs -14] [--music track.mp3] [--lang hi] [--transcript file.json] [--out dir]");
  process.exit(1);
}
const workDir = resolve(opt("out") ?? `data/cli-${basename(input).replace(/\W+/g, "_")}-${Date.now()}`);
const result = await processVideo({
  input: resolve(input),
  workDir,
  strength: opt("strength") ?? "medium",
  smart: args.includes("--smart"),
  captions: !args.includes("--no-captions"),
  cleanAudio: !args.includes("--no-audio"),
  music: opt("music") ? resolve(opt("music")) : undefined,
  musicVolume: opt("music-volume") ? Number(opt("music-volume")) : 0.18,
  lufs: opt("lufs") ? Number(opt("lufs")) : -14,
  language: opt("lang"),
  transcriptPath: opt("transcript") ? resolve(opt("transcript")) : undefined,
  onStage: (s) => console.error(`[${s}]`),
});
console.log(JSON.stringify(result, null, 2));
