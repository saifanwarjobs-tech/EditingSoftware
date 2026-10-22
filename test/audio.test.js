import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAudioChain, buildLoudnorm, parseLoudnorm, cleanAudio } from "../src/audio.js";
import { run } from "../src/exec.js";

let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

const SAMPLE = `junk\n{\n\t"input_i" : "-23.63",\n\t"input_tp" : "-18.56",\n\t"input_lra" : "0.10",\n\t"input_thresh" : "-33.63",\n\t"target_offset" : "0.02"\n}\n`;

test("audio chain: denoise on/off and clamped strength", () => {
  assert.match(buildAudioChain(), /afftdn=nr=12/);
  assert.doesNotMatch(buildAudioChain({ denoise: false }), /afftdn|highpass/);
  assert.match(buildAudioChain({ noiseReduction: 99 }), /nr=20/);
  assert.match(buildAudioChain({ noiseReduction: 1 }), /nr=6/);
  assert.match(buildAudioChain({ denoise: false }), /acompressor/);
});

test("parseLoudnorm reads FFmpeg output and rejects -inf", () => {
  assert.equal(parseLoudnorm(SAMPLE).input_i, "-23.63");
  assert.equal(parseLoudnorm("no json here"), null);
  assert.equal(parseLoudnorm(SAMPLE.replace("-23.63", "-inf")), null);
});

test("buildLoudnorm: two-pass vs single-pass", () => {
  assert.match(buildLoudnorm(-14, parseLoudnorm(SAMPLE)), /measured_I=-23.63.*linear=true/);
  assert.equal(buildLoudnorm(-16, null), "loudnorm=I=-16:TP=-1.5:LRA=11");
});

test("cleanAudio hits the target loudness; silent audio does not crash", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ave-a-"));
  const input = join(dir, "in.mp4"), output = join(dir, "out.mp4"), silent = join(dir, "s.mp4"), silentOut = join(dir, "so.mp4");
  const mk = (file, audioSrc) => execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=5", "-f", "lavfi", "-i", audioSrc,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file], { stdio: "ignore" });
  mk(input, "sine=frequency=300:duration=5");
  const r = await cleanAudio({ input, output, lufs: -14 });
  assert.equal(r.twoPass, true);
  const { err } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", output, "-vn", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
  const lufs = Number(parseLoudnorm(err).input_i);
  assert.ok(Math.abs(lufs + 14) < 1, `expected about -14 LUFS, got ${lufs}`);

  mk(silent, "anullsrc=r=48000:cl=mono"); // pure silence => measured loudness is -inf
  const r2 = await cleanAudio({ input: silent, output: silentOut });
  assert.equal(r2.twoPass, false);
});
