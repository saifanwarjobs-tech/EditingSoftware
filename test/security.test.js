import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter, matchToken, ownerId, parseCookies } from "../src/security.js";
import { JobStore } from "../src/jobs.js";

test("matchToken: exact match only", () => {
  assert.equal(matchToken("abc", ["x", "abc"]), "abc");
  assert.equal(matchToken("abd", ["abc"]), null);
  assert.equal(matchToken("", ["abc"]), null);
  assert.equal(matchToken(undefined, ["abc"]), null);
});

test("ownerId is stable, distinct per token and does not contain the token", () => {
  assert.equal(ownerId("a"), ownerId("a"));
  assert.notEqual(ownerId("a"), ownerId("b"));
  assert.ok(!ownerId("secret-token").includes("secret"));
});

test("parseCookies", () => {
  assert.deepEqual(parseCookies("a=1; ave_token=x%20y; b=2"), { a: "1", ave_token: "x y", b: "2" });
  assert.deepEqual(parseCookies(undefined), {});
});

test("rate limiter blocks after the limit and frees up after the window", () => {
  const rl = new RateLimiter();
  assert.ok(rl.hit("u", 2, 1000, 0).ok);
  assert.ok(rl.hit("u", 2, 1000, 100).ok);
  const blocked = rl.hit("u", 2, 1000, 200);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.ok(rl.hit("u", 2, 1000, 1500).ok); // window passed
  assert.ok(rl.hit("other", 2, 1000, 200).ok); // separate keys are independent
});

test("job store persists, reloads, requeues interrupted jobs and gives up after 2 attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-js-"));
  const a = new JobStore(root);
  await a.create({ id: "11111111-1111-1111-1111-111111111111", owner: "o", opts: {} });
  await a.update("11111111-1111-1111-1111-111111111111", { status: "processing", attempts: 1 });
  await a.create({ id: "22222222-2222-2222-2222-222222222222", owner: "o", opts: {} });
  await a.update("22222222-2222-2222-2222-222222222222", { status: "processing", attempts: 2 });
  await a.create({ id: "33333333-3333-3333-3333-333333333333", owner: "o", opts: {} });
  await a.update("33333333-3333-3333-3333-333333333333", { status: "done" });

  const b = new JobStore(root);
  const requeue = await b.load();
  assert.deepEqual(requeue, ["11111111-1111-1111-1111-111111111111"]);
  assert.equal(b.get("22222222-2222-2222-2222-222222222222").status, "error");
  assert.equal(b.get("33333333-3333-3333-3333-333333333333").status, "done");
});

test("cleanup removes old finished jobs and keeps recent/active ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-cl-"));
  const s = new JobStore(root);
  await s.create({ id: "aaaaaaaa-0000-0000-0000-000000000000", owner: "o" });
  await s.update("aaaaaaaa-0000-0000-0000-000000000000", { status: "done" });
  await s.create({ id: "bbbbbbbb-0000-0000-0000-000000000000", owner: "o" });
  await s.update("bbbbbbbb-0000-0000-0000-000000000000", { status: "processing" });
  const later = Date.now() + 48 * 3600_000;
  assert.equal(await s.cleanup(24 * 3600_000, later), 1);
  assert.ok(!existsSync(s.dir("aaaaaaaa-0000-0000-0000-000000000000")));
  assert.ok(existsSync(s.dir("bbbbbbbb-0000-0000-0000-000000000000"))); // active job is never deleted
});
