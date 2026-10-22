import test from "node:test";
import assert from "node:assert/strict";
import { buildEdl, remapWords, totalDuration } from "../src/autocut.js";
import { parseRemovals } from "../src/smartcut.js";
import { groupCues, toSrt } from "../src/captions.js";
import { buildFilterScript } from "../src/cutter.js";
import { normalizeWords } from "../src/transcribe.js";

const W = (text, start, end, id) => ({ id, text, start, end });
const words = [
  W("Hello", 0.5, 0.9, 0), W("everyone", 0.95, 1.5, 1),
  W("umm", 1.6, 2.0, 2),
  W("today", 2.1, 2.5, 3), W("we", 2.55, 2.7, 4),
  // 3 second pause
  W("start", 5.7, 6.1, 5),
];

test("long pauses are shortened and fillers removed", () => {
  const edl = buildEdl(words, { strength: "medium", duration: 7 });
  assert.equal(edl.length, 3); // before umm / between umm and pause / after pause
  const total = totalDuration(edl);
  assert.ok(total < 5, `expected much shorter than 7s, got ${total}`);
  // the umm (1.6-2.0) must not be fully inside any kept range
  for (const [s, e] of edl) assert.ok(!(s <= 1.65 && e >= 1.95), "filler leaked into kept range");
});

test("ranges are sorted, non-overlapping, within duration", () => {
  const edl = buildEdl(words, { strength: "aggressive", duration: 7 });
  for (let i = 0; i < edl.length; i++) {
    assert.ok(edl[i][0] < edl[i][1]);
    assert.ok(edl[i][0] >= 0 && edl[i][1] <= 7);
    if (i) assert.ok(edl[i][0] >= edl[i - 1][1]);
  }
});

test("removeIds drops words (smart cut)", () => {
  const edl = buildEdl(words, { duration: 7, removeIds: [5] });
  assert.ok(edl.every(([, e]) => e < 5.6));
});

test("remapWords shifts timestamps onto the edited timeline", () => {
  const edl = [[0, 1], [5, 6]];
  const out = remapWords([W("a", 0.2, 0.4, 0), W("b", 5.2, 5.5, 1), W("x", 3, 3.2, 2)], edl);
  assert.deepEqual(out.map((w) => [w.text, w.start, w.end]), [["a", 0.2, 0.4], ["b", 1.2, 1.5]]);
});

test("parseRemovals validates model output and caps deletions", () => {
  const ws = Array.from({ length: 10 }, (_, i) => W("w" + i, i, i + 0.5, i));
  assert.equal(parseRemovals("garbage", ws).ids.size, 0);
  assert.equal(parseRemovals('{"remove":[{"from":2,"to":99}]}', ws).ids.size, 0);
  assert.deepEqual([...parseRemovals('```json\n{"remove":[{"from":1,"to":2,"reason":"retake"}]}\n```', ws).ids], [1, 2]);
  assert.equal(parseRemovals('{"remove":[{"from":0,"to":9}]}', ws).ids.size, 0); // >40% rejected
});

test("captions group into cues and render SRT", () => {
  const cues = groupCues([W("Hello", 0, 0.4), W("world.", 0.4, 0.9), W("Next", 1.2, 1.5)]);
  assert.equal(cues.length, 2);
  assert.match(toSrt(cues), /00:00:00,000 --> /);
});

test("filter script has one trim pair per segment and a concat", () => {
  const s = buildFilterScript([[0, 1], [2, 3]]);
  assert.match(s, /concat=n=2:v=1:a=1\[vc\]/);
  assert.equal((s.match(/atrim=/g) || []).length, 2);
});

test("normalizeWords accepts several transcript shapes", () => {
  assert.equal(normalizeWords([{ text: "hi", start: 0, end: 1 }]).length, 1);
  assert.equal(normalizeWords({ words: [{ word: "hi", start: 0, end: 1 }] })[0].text, "hi");
});
