// Zero-dependency HTTP server: login (optional), upload a raw video, poll the job, stream/download the result.
import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as baseConfig } from "./config.js";
import { processVideo } from "./pipeline.js";
import { JobStore, publicView } from "./jobs.js";
import { RateLimiter, clientIp, matchToken, ownerId, parseCookies } from "./security.js";

const ALLOWED_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const MUSIC_RE = /^[\w][\w .()-]*\.(mp3|wav|m4a|aac|ogg)$/i;
const isId = (s) => /^[0-9a-f-]{36}$/.test(s);
const COOKIE = "ave_token";
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self'; frame-ancestors 'none'";

/**
 * @param {object} [overrides]  config overrides (used by tests)
 * @param {{processFn?:Function}} [deps]
 */
export function createApp(overrides = {}, { processFn = processVideo } = {}) {
  const cfg = { ...baseConfig, ...overrides };
  const store = new JobStore(join(cfg.dataDir, "jobs"));
  const limiter = new RateLimiter();
  const queue = [];
  let running = false;
  let timers = [];

  // ---------- job queue (one render at a time) ----------
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const id = queue.shift();
      const rec = store.get(id);
      if (!rec) continue;
      await store.update(id, { status: "processing", stage: "starting", attempts: rec.attempts + 1 });
      try {
        const result = await processFn({
          ...rec.opts,
          maxDurationSeconds: cfg.maxVideoMinutes * 60,
          onStage: (s) => { rec.stage = s; store.update(id, { stage: s }); },
        });
        await store.update(id, { status: "done", stage: "done", report: result.report });
      } catch (e) {
        await store.update(id, { status: "error", error: String(e.message).slice(0, 500) });
      }
    }
    running = false;
  }
  const activeJobs = () => queue.length + (running ? 1 : 0);

  // ---------- helpers ----------
  const json = (res, code, body, extra = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...extra });
    res.end(JSON.stringify(body));
  };
  const authRequired = cfg.accessTokens.length > 0;

  /** @returns {{owner:string, token:string|null}|null} */
  function authenticate(req) {
    if (!authRequired) return { owner: "public", token: null };
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const token = matchToken(bearer ?? parseCookies(req.headers.cookie)[COOKIE], cfg.accessTokens);
    return token ? { owner: ownerId(token), token } : null;
  }
  const secure = (req) => cfg.secureCookies || (cfg.trustProxy && req.headers["x-forwarded-proto"] === "https");

  async function listMusic() {
    try { return (await readdir(cfg.musicDir)).filter((f) => MUSIC_RE.test(f)).sort(); } catch { return []; }
  }

  async function readSmallJson(req, max = 4096) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > max) throw new Error("too large");
    }
    return JSON.parse(body || "{}");
  }

  // ---------- upload ----------
  async function handleUpload(req, res, url, user) {
    const rl = limiter.hit(`up:${authRequired ? user.owner : clientIp(req, cfg.trustProxy)}`, cfg.rateLimitPerHour, 3600_000);
    if (!rl.ok) return json(res, 429, { error: `Upload limit reached. Try again in ${Math.ceil(rl.retryAfterSec / 60)} min.` }, { "retry-after": rl.retryAfterSec });
    if (activeJobs() >= cfg.maxQueue) return json(res, 503, { error: "Server is busy, please try again in a few minutes." }, { "retry-after": 120 });

    const musicName = url.searchParams.get("music");
    const music = musicName && (await listMusic()).includes(musicName) ? join(cfg.musicDir, musicName) : null; // library only, never a client path
    if (musicName && !music) return json(res, 400, { error: "Unknown music track" });
    const ext = extname(url.searchParams.get("filename") ?? "video.mp4").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return json(res, 400, { error: "Unsupported file type" });
    if (Number(req.headers["content-length"] ?? 0) > cfg.maxUploadBytes) return json(res, 413, { error: "File too large" });

    const id = randomUUID();
    const dir = store.dir(id);
    await store.create({ id, owner: user.owner, status: "uploading", stage: "uploading", opts: null });
    const input = join(dir, `input${ext}`);

    let received = 0, aborted = false;
    const fail = async (code, msg) => {
      aborted = true;
      await rm(dir, { recursive: true, force: true });
      store.jobs.delete(id);
      if (!res.headersSent) json(res, code, { error: msg }, { connection: "close" });
    };
    const out = createWriteStream(input);
    req.on("data", (c) => {
      received += c.length;
      if (received > cfg.maxUploadBytes && !aborted) { out.destroy(); fail(413, "File too large"); }
    });
    req.on("aborted", () => { if (!aborted) { out.destroy(); fail(400, "Upload cancelled"); } });
    req.pipe(out);
    out.on("error", () => { if (!aborted) fail(500, "Upload failed"); });
    out.on("finish", async () => {
      if (aborted) return;
      const q = url.searchParams;
      const opts = {
        input, workDir: dir,
        strength: ["light", "medium", "aggressive"].includes(q.get("strength")) ? q.get("strength") : "medium",
        language: /^[a-z]{2,3}$/.test(q.get("lang") ?? "") ? q.get("lang") : undefined,
        smart: q.get("smart") === "1",
        captions: q.get("captions") !== "0",
        captionStyle: ["plain", "karaoke", "pop"].includes(q.get("captionStyle")) ? q.get("captionStyle") : "plain",
        cleanAudio: q.get("audio") !== "0",
        lufs: q.get("lufs") === "-16" ? -16 : -14,
        music,
        musicVolume: Math.min(1, Math.max(0.02, Number(q.get("musicVolume")) || 0.18)),
      };
      await store.update(id, { status: "queued", stage: "queued", opts });
      queue.push(id);
      pump();
      json(res, 202, { id });
    });
  }

  // ---------- file streaming with Range support (needed by Safari/iOS video) ----------
  async function sendFile(req, res, path, type, downloadName) {
    if (!existsSync(path)) return json(res, 404, { error: "Not found" });
    const { size } = await stat(path);
    const headers = { "content-type": type, "accept-ranges": "bytes" };
    if (downloadName) headers["content-disposition"] = `attachment; filename="${downloadName}"`;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      return createReadStream(path, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(path).pipe(res);
  }

  // ---------- routes ----------
  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true, queue: activeJobs() });
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP });
        return res.end(await readFile(resolve("public/index.html")));
      }

      if (req.method === "POST" && path === "/api/login") {
        const ip = clientIp(req, cfg.trustProxy);
        const rl = limiter.hit(`login:${ip}`, 10, 600_000); // brute-force guard
        if (!rl.ok) return json(res, 429, { error: "Too many attempts. Try again later." }, { "retry-after": rl.retryAfterSec });
        let token = "";
        try { token = String((await readSmallJson(req)).token ?? ""); } catch { return json(res, 400, { error: "Bad request" }); }
        if (!authRequired) return json(res, 200, { ok: true });
        if (!matchToken(token, cfg.accessTokens)) return json(res, 401, { error: "Wrong access code" });
        const cookie = `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure(req) ? "; Secure" : ""}`;
        return json(res, 200, { ok: true }, { "set-cookie": cookie });
      }
      if (req.method === "POST" && path === "/api/logout") {
        return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (req.method === "GET" && path === "/api/me") {
        return json(res, 200, { authRequired, authenticated: !!authenticate(req) });
      }

      // everything below needs a valid user
      const user = authenticate(req);
      if (path.startsWith("/api/") && !user) return json(res, 401, { error: "Login required" });

      if (req.method === "GET" && path === "/api/music") return json(res, 200, { tracks: await listMusic() });
      if (req.method === "POST" && path === "/api/jobs") return handleUpload(req, res, url, user);

      const m = path.match(/^\/api\/jobs\/([^/]+)(?:\/(video|captions))?$/);
      if (req.method === "GET" && m && isId(m[1])) {
        const rec = store.get(m[1]);
        if (!rec || rec.owner !== user.owner) return json(res, 404, { error: "Unknown job" }); // same answer for "not yours"
        const dir = store.dir(m[1]);
        const dl = url.searchParams.get("download") === "1";
        if (m[2] === "video" && rec.status === "done") return sendFile(req, res, join(dir, "output.mp4"), "video/mp4", dl ? "edited.mp4" : null);
        if (m[2] === "captions" && rec.status === "done") return sendFile(req, res, join(dir, "captions.srt"), "text/plain; charset=utf-8", dl ? "captions.srt" : null);
        if (m[2]) return json(res, 409, { error: "Job is not finished" });
        return json(res, 200, publicView(rec));
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: "Server error" });
    }
  });

  // ---------- lifecycle ----------
  async function start({ port = cfg.port, host } = {}) {
    const requeue = await store.load();
    queue.push(...requeue);
    await store.cleanup(cfg.retentionHours * 3600_000);
    timers = [
      setInterval(() => store.cleanup(cfg.retentionHours * 3600_000).catch(() => {}), 3600_000),
      setInterval(() => limiter.prune(), 600_000),
    ];
    timers.forEach((t) => t.unref());
    await new Promise((r) => server.listen(port, host, r));
    pump();
    return server.address().port;
  }
  async function stop() {
    timers.forEach(clearInterval);
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }

  return { server, start, stop, store, cfg };
}

// run directly: `node src/server.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!baseConfig.accessTokens.length) {
    console.warn("WARNING: ACCESS_TOKENS is empty, anyone who can reach this server can upload videos. Set it before exposing the server publicly.");
  }
  const app = createApp();
  app.start().then((port) => console.log(`Auto Video Editor on http://localhost:${port}`));
}
