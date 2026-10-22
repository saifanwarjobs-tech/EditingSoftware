import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processVideo } from "../src/pipeline.js";
import { probe } from "../src/cutter.js";

let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

test("end-to-end: 8s synthetic video with a 3s gap gets shorter", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ave-"));
  const input = join(dir, "in.mp4");
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=8",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input], { stdio: "ignore" });
  const transcript = join(dir, "t.json");
  writeFileSync(transcript, JSON.stringify([
    { text: "Hello", start: 0.5, end: 1.0 }, { text: "umm", start: 1.1, end: 1.5 },
    { text: "world", start: 1.6, end: 2.0 }, { text: "again", start: 5.0, end: 5.5 },
  ]));
  const r = await processVideo({ input, workDir: join(dir, "out"), transcriptPath: transcript, strength: "medium" });
  assert.ok(existsSync(r.output));
  const info = await probe(r.output);
  assert.ok(info.duration < 4, `edited duration ${info.duration}`);
  assert.ok(r.report.removedSeconds > 3);
  assert.match(r.report.audio, /normalised/);
});
