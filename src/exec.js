import { spawn } from "node:child_process";

/** Run a command, resolve {out, err}; reject with a readable message on failure. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(e.code === "ENOENT" ? `${cmd} not found. Install FFmpeg.` : e.message)));
    p.on("close", (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} failed (${code}): ${err.slice(-800)}`))));
  });
}
