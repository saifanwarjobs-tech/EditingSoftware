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

import { buildAudioGraph } from "../src/audio.js";

test("audio graph: no music = plain chain, music = sidechain ducking graph", () => {
  const plain = buildAudioGraph({ pre: "highpass=f=80", loudnorm: "loudnorm=I=-14" });
  assert.equal(plain.usesComplex, false);
  const mixed = buildAudioGraph({ pre: "highpass=f=80", loudnorm: "loudnorm=I=-14", music: true, musicVolume: 0.5 });
  assert.equal(mixed.usesComplex, true);
  assert.match(mixed.filter, /sidechaincompress/);
  assert.match(mixed.filter, /volume=0.5/);
  assert.match(mixed.filter, /amix=inputs=2:duration=first/);
  assert.match(buildAudioGraph({ pre: "x", loudnorm: "y", music: true, musicVolume: 99 }).filter, /volume=1\b/); // clamped
});

test("music is ducked while the voice speaks and recovers in the pause", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ave-m-"));
  const input = join(dir, "in.mp4"), music = join(dir, "m.wav"), output = join(dir, "out.mp4");
  // voice: 300 Hz for 2 s, then 3 s of silence. music: constant 1000 Hz (shorter than the video => must loop)
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=5", "-filter_complex",
    "sine=frequency=300:duration=2[a];anullsrc=r=44100:cl=mono,atrim=duration=3[b];[a][b]concat=n=2:v=0:a=1[aud]",
    "-map", "0:v", "-map", "[aud]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=2", music], { stdio: "ignore" });

  await cleanAudio({ input, output, music, musicVolume: 0.3, denoise: false });

  const musicLevel = async (from, to) => {
    const { err } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", output, "-vn", "-af",
      `atrim=start=${from}:end=${to},bandpass=f=1000:width_type=h:w=200,volumedetect`, "-f", "null", "-"]);
    return Number(err.match(/mean_volume: (-?[\d.]+) dB/)[1]);
  };
  const duringSpeech = await musicLevel(0.6, 1.6);
  const duringPause = await musicLevel(3.2, 4.4); // also proves the 2 s music loops to cover the 5 s video
  assert.ok(duringPause - duringSpeech > 3, `music should be >3 dB quieter under speech (speech ${duringSpeech} dB, pause ${duringPause} dB)`);
});
