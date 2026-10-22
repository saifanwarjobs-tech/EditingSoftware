import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";

// Stub the heavy pipeline: write a fake output and return a report.
const fakeProcess = async ({ workDir, onStage }) => {
  onStage("rendering");
  writeFileSync(join(workDir, "output.mp4"), Buffer.from("0123456789".repeat(10)));
  writeFileSync(join(workDir, "captions.srt"), "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
  return { report: { originalSeconds: 10, editedSeconds: 8, removedSeconds: 2 } };
};

async function boot(overrides = {}, deps = { processFn: fakeProcess }) {
  const dataDir = mkdtempSync(join(tmpdir(), "ave-srv-"));
  const app = createApp({ dataDir, accessTokens: [], rateLimitPerHour: 100, ...overrides }, deps);
  const port = await app.start({ port: 0, host: "127.0.0.1" });
  return { app, base: `http://127.0.0.1:${port}`, dataDir };
}
const upload = (base, headers = {}, qs = "filename=a.mp4") => fetch(`${base}/api/jobs?${qs}`, { method: "POST", body: Buffer.from("video-bytes"), headers });
async function waitDone(base, id, headers = {}) {
  for (let i = 0; i < 50; i++) {
    const j = await (await fetch(`${base}/api/jobs/${id}`, { headers })).json();
    if (j.status === "done" || j.status === "error") return j;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timeout");
}

test("open mode: upload, finish, stream with Range, download header", async () => {
  const { app, base } = await boot();
  try {
    assert.deepEqual(await (await fetch(`${base}/api/me`)).json(), { authRequired: false, authenticated: true });
    const r = await upload(base);
    assert.equal(r.status, 202);
    const { id } = await r.json();
    const done = await waitDone(base, id);
    assert.equal(done.status, "done");
    assert.equal(done.report.removedSeconds, 2);
    assert.equal(done.opts, undefined); // internals are not exposed
    assert.equal(done.owner, undefined);

    const part = await fetch(`${base}/api/jobs/${id}/video`, { headers: { range: "bytes=0-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 0-9/100");
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    const dl = await fetch(`${base}/api/jobs/${id}/video?download=1`);
    assert.match(dl.headers.get("content-disposition"), /attachment/);
    assert.equal((await fetch(`${base}/api/jobs/${id}/video`, { headers: { range: "bytes=500-600" } })).status, 416);
  } finally { await app.stop(); }
});

test("auth: protected API, wrong/right code, bearer, and users cannot see each other's jobs", async () => {
  const { app, base } = await boot({ accessTokens: ["code-alice", "code-bob"] });
  try {
    assert.equal((await upload(base)).status, 401);
    assert.equal((await fetch(`${base}/api/music`)).status, 401);
    assert.equal((await fetch(`${base}/healthz`)).status, 200); // health check stays public

    const bad = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ token: "nope" }) });
    assert.equal(bad.status, 401);
    const good = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ token: "code-alice" }) });
    assert.equal(good.status, 200);
    const cookie = good.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const cookieHeader = { cookie: cookie.split(";")[0] };

    const r = await upload(base, cookieHeader);
    assert.equal(r.status, 202);
    const { id } = await r.json();
    assert.equal((await waitDone(base, id, cookieHeader)).status, "done");

    const bob = { authorization: "Bearer code-bob" };
    assert.equal((await fetch(`${base}/api/jobs/${id}`, { headers: bob })).status, 404);
    assert.equal((await fetch(`${base}/api/jobs/${id}/video`, { headers: bob })).status, 404);
    assert.equal((await fetch(`${base}/api/jobs/${id}`, { headers: { authorization: "Bearer code-alice" } })).status, 200);
  } finally { await app.stop(); }
});

test("login attempts are rate limited", async () => {
  const { app, base } = await boot({ accessTokens: ["secret"] });
  try {
    let last;
    for (let i = 0; i < 12; i++) last = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ token: "x" + i }) });
    assert.equal(last.status, 429);
  } finally { await app.stop(); }
});

test("rejects bad file types and music paths", async () => {
  const { app, base } = await boot();
  try {
    assert.equal((await upload(base, {}, "filename=evil.exe")).status, 400);
    assert.equal((await upload(base, {}, "filename=a.mp4&music=../../etc/passwd")).status, 400);
    assert.equal((await upload(base, {}, "filename=a.mp4&music=nope.mp3")).status, 400);
  } finally { await app.stop(); }
});

test("upload rate limit and busy-queue protection", async () => {
  const b = await boot({ rateLimitPerHour: 2 });
  try {
    assert.equal((await upload(b.base)).status, 202);
    assert.equal((await upload(b.base)).status, 202);
    const third = await upload(b.base);
    assert.equal(third.status, 429);
    assert.ok(third.headers.get("retry-after"));
  } finally { await b.app.stop(); }
  const c = await boot({ maxQueue: 0 });
  try { assert.equal((await upload(c.base)).status, 503); } finally { await c.app.stop(); }
});

test("jobs survive a restart and interrupted jobs are re-run", async () => {
  const { app, base, dataDir } = await boot();
  const { id } = await (await upload(base)).json();
  await waitDone(base, id);
  // simulate a job that was mid-processing when the server died
  const pending = "99999999-9999-9999-9999-999999999999";
  await app.store.create({ id: pending, owner: "public", opts: { workDir: app.store.dir(pending), input: "x" } });
  await app.store.update(pending, { status: "processing", attempts: 1 });
  await app.stop();

  const app2 = createApp({ dataDir, accessTokens: [] }, { processFn: fakeProcess });
  const port = await app2.start({ port: 0, host: "127.0.0.1" });
  const base2 = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await (await fetch(`${base2}/api/jobs/${id}`)).json()).status, "done"); // survived
    assert.equal((await waitDone(base2, pending)).status, "done"); // re-queued and finished
  } finally { await app2.stop(); }
});

test("errors from the pipeline are reported, not crashing the server", async () => {
  const { app, base } = await boot({}, { processFn: async () => { throw new Error("Video is too long (45 min). Maximum is 30 min."); } });
  try {
    const { id } = await (await upload(base)).json();
    const j = await waitDone(base, id);
    assert.equal(j.status, "error");
    assert.match(j.error, /too long/);
    assert.equal((await fetch(`${base}/api/jobs/${id}/video`)).status, 409);
  } finally { await app.stop(); }
});
