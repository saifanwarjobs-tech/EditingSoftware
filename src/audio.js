// Audio cleanup: noise reduction + voice EQ + compression + two-pass loudness normalisation.
// Video stream is copied untouched (fast, no quality loss).
import { rename, unlink } from "node:fs/promises";
import { run } from "./exec.js";

export function buildAudioChain({ denoise = true, noiseReduction = 12 } = {}) {
  const nr = Math.min(20, Math.max(6, Number(noiseReduction) || 12)); // dB, clamp to a sane range
  const chain = [];
  if (denoise) {
    chain.push("highpass=f=80");                 // rumble / hum
    chain.push(`afftdn=nr=${nr}:nf=-30`);        // background noise
    chain.push("equalizer=f=250:t=q:w=1:g=-2");  // less boominess
    chain.push("equalizer=f=3000:t=q:w=1:g=2.5");// voice clarity
  }
  chain.push("acompressor=threshold=-18dB:ratio=3:attack=20:release=250:makeup=2");
  return chain.join(",");
}

/** Pull the loudnorm JSON block out of FFmpeg's stderr. Returns null if missing/unusable. */
export function parseLoudnorm(stderr) {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const vals = [j.input_i, j.input_tp, j.input_lra, j.input_thresh, j.target_offset].map(Number);
  return vals.every(Number.isFinite) ? j : null; // "-inf" (silent audio) => fall back to single pass
}

export function buildLoudnorm(lufs, measured) {
  const base = `loudnorm=I=${lufs}:TP=-1.5:LRA=11`;
  if (!measured) return base;
  return `${base}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
}

/**
 * @param {{input:string, output:string, lufs?:number, denoise?:boolean, noiseReduction?:number}} o
 * @returns {Promise<{measuredLufs:number|null, twoPass:boolean}>}
 */
export async function cleanAudio({ input, output, lufs = -14, denoise = true, noiseReduction = 12 }) {
  const pre = buildAudioChain({ denoise, noiseReduction });

  // Pass 1: measure
  const { err } = await run("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", input, "-vn",
    "-af", `${pre},loudnorm=I=${lufs}:TP=-1.5:LRA=11:print_format=json`,
    "-f", "null", "-",
  ]);
  const measured = parseLoudnorm(err);

  // Pass 2: apply, video copied as-is
  await run("ffmpeg", [
    "-hide_banner", "-y", "-nostdin", "-i", input,
    "-map", "0:v:0?", "-map", "0:a:0", "-c:v", "copy",
    "-af", `${pre},${buildLoudnorm(lufs, measured)}`,
    "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ]);
  return { measuredLufs: measured ? Number(measured.input_i) : null, twoPass: !!measured };
}

/** Clean audio of a file in place (writes a temp file, then replaces the original). */
export async function cleanAudioInPlace(path, opts) {
  const tmp = `${path}.clean.mp4`;
  try {
    const r = await cleanAudio({ input: path, output: tmp, ...opts });
    await rename(tmp, path);
    return r;
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
