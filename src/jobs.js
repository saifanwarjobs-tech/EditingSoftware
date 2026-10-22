// Persistent job store: every job is a folder with job.json, so jobs survive restarts.
import { mkdir, readFile, writeFile, readdir, rm, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export class JobStore {
  constructor(root) { this.root = root; this.jobs = new Map(); }
  dir(id) { return join(this.root, id); }
  get(id) { return this.jobs.get(id); }

  async #persist(rec) {
    const file = join(this.dir(rec.id), "job.json");
    await writeFile(`${file}.tmp`, JSON.stringify(rec));
    await rename(`${file}.tmp`, file); // atomic: never a half-written job.json
  }

  async create(rec) {
    const full = { status: "queued", stage: "queued", attempts: 0, createdAt: Date.now(), ...rec, updatedAt: Date.now() };
    await mkdir(this.dir(full.id), { recursive: true });
    this.jobs.set(full.id, full);
    await this.#persist(full);
    return full;
  }

  async update(id, patch) {
    const rec = this.jobs.get(id);
    if (!rec) return null;
    Object.assign(rec, patch, { updatedAt: Date.now() });
    await this.#persist(rec).catch(() => {}); // folder may have been cleaned up meanwhile
    return rec;
  }

  /** Load jobs from disk. Returns ids that should be re-queued (were queued/processing when the server stopped). */
  async load() {
    await mkdir(this.root, { recursive: true });
    const requeue = [];
    for (const id of await readdir(this.root)) {
      try {
        const rec = JSON.parse(await readFile(join(this.dir(id), "job.json"), "utf8"));
        this.jobs.set(rec.id, rec);
        if (rec.status === "queued" || rec.status === "processing") {
          if ((rec.attempts ?? 0) >= 2) {
            rec.status = "error"; rec.error = "Processing was interrupted repeatedly; please upload again.";
            await this.#persist(rec);
          } else requeue.push(rec.id);
        }
      } catch { /* folder without a valid job.json: handled by cleanup() */ }
    }
    return requeue.sort((a, b) => this.jobs.get(a).createdAt - this.jobs.get(b).createdAt);
  }

  /** Delete finished jobs (and orphan folders from aborted uploads) older than retentionMs. */
  async cleanup(retentionMs, now = Date.now()) {
    let removed = 0;
    let ids = [];
    try { ids = await readdir(this.root); } catch { return 0; }
    for (const id of ids) {
      const rec = this.jobs.get(id);
      let stale = false;
      if (rec) stale = ["done", "error", "uploading"].includes(rec.status) && now - rec.updatedAt > retentionMs; // "uploading" = interrupted upload
      else {
        const s = await stat(this.dir(id)).catch(() => null);
        stale = !!s && now - s.mtimeMs > retentionMs; // orphan (no job record)
      }
      if (stale) { await rm(this.dir(id), { recursive: true, force: true }); this.jobs.delete(id); removed++; }
    }
    return removed;
  }
}

export const publicView = (rec) => ({ status: rec.status, stage: rec.stage, report: rec.report, error: rec.error });
