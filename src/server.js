// Zero-dependency HTTP server: upload a raw video, poll the job, download the result.
import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { config } from "./config.js";
import { processVideo } from "./pipeline.js";

const jobs = new Map(); // id -> {status, stage, report?, error?}
const queue = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    const state = jobs.get(job.id);
    try {
      state.status = "processing";
      const result = await processVideo({ ...job.opts, onStage: (s) => (state.stage = s) });
      state.status = "done"; state.stage = "done"; state.report = result.report;
    } catch (e) {
      state.status = "error"; state.error = e.message;
    }
  }
  running = false;
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const isId = (s) => /^[0-9a-f-]{36}$/.test(s);
const ALLOWED_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const MUSIC_RE = /^[\w][\w .()-]*\.(mp3|wav|m4a|aac|ogg)$/i;

async function listMusic() {
  try { return (await readdir(config.musicDir)).filter((f) => MUSIC_RE.test(f)).sort(); } catch { return []; }
}

async function handleUpload(req, res, url) {
  // music is chosen from the server-side library only (never a client-supplied path)
  const musicName = url.searchParams.get("music");
  const music = musicName && (await listMusic()).includes(musicName) ? join(config.musicDir, musicName) : null;
  if (musicName && !music) return json(res, 400, { error: "Unknown music track" });
  const ext = extname(url.searchParams.get("filename") ?? "video.mp4").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return json(res, 400, { error: "Unsupported file type" });
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > config.maxUploadBytes) return json(res, 413, { error: "File too large" });

  const id = randomUUID();
  const dir = join(config.dataDir, "jobs", id);
  await mkdir(dir, { recursive: true });
  const input = join(dir, `input${ext}`);

  let received = 0, aborted = false;
  const out = createWriteStream(input);
  req.on("data", (c) => {
    received += c.length;
    if (received > config.maxUploadBytes && !aborted) {
      aborted = true; req.destroy(); out.destroy();
    }
  });
  req.pipe(out);
  out.on("finish", () => {
    if (aborted) return;
    const strength = ["light", "medium", "aggressive"].includes(url.searchParams.get("strength")) ? url.searchParams.get("strength") : "medium";
    const lang = /^[a-z]{2,3}$/.test(url.searchParams.get("lang") ?? "") ? url.searchParams.get("lang") : undefined;
    jobs.set(id, { status: "queued", stage: "queued" });
    queue.push({
      id,
      opts: {
        input, workDir: dir, strength, language: lang,
        smart: url.searchParams.get("smart") === "1",
        captions: url.searchParams.get("captions") !== "0",
        captionStyle: ["plain", "karaoke", "pop"].includes(url.searchParams.get("captionStyle")) ? url.searchParams.get("captionStyle") : "plain",
        cleanAudio: url.searchParams.get("audio") !== "0",
        lufs: url.searchParams.get("lufs") === "-16" ? -16 : -14,
        music,
        musicVolume: Math.min(1, Math.max(0.02, Number(url.searchParams.get("musicVolume")) || 0.18)),
      },
    });
    pump();
    json(res, 202, { id });
  });
  out.on("error", () => !res.headersSent && json(res, 500, { error: "Upload failed" }));
}

async function sendFile(res, path, type, download) {
  if (!existsSync(path)) return json(res, 404, { error: "Not found" });
  const { size } = await stat(path);
  const headers = { "content-type": type, "content-length": size };
  if (download) headers["content-disposition"] = `attachment; filename="${download}"`;
  res.writeHead(200, headers);
  createReadStream(path).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(resolve("public/index.html")));
    }
    if (req.method === "GET" && url.pathname === "/api/music") return json(res, 200, { tracks: await listMusic() });
    if (req.method === "POST" && url.pathname === "/api/jobs") return handleUpload(req, res, url);

    const m = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(video|captions))?$/);
    if (req.method === "GET" && m && isId(m[1])) {
      const state = jobs.get(m[1]);
      if (!state) return json(res, 404, { error: "Unknown job" });
      const dir = join(config.dataDir, "jobs", m[1]);
      if (m[2] === "video" && state.status === "done") return sendFile(res, join(dir, "output.mp4"), "video/mp4", "edited.mp4");
      if (m[2] === "captions" && state.status === "done") return sendFile(res, join(dir, "captions.srt"), "text/plain; charset=utf-8", "captions.srt");
      return json(res, 200, state);
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: "Server error" });
  }
});

server.listen(config.port, () => console.log(`Auto Video Editor on http://localhost:${config.port}`));
export { server };
