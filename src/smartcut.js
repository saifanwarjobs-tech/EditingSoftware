// Step 2 (optional, smart): ask Claude which parts of the transcript to remove
// (repeated takes, false starts, off-topic tangents). Returns word ids to drop.
import { config } from "./config.js";

const SYSTEM = `You are a video editor's assistant. You receive a transcript where every word has an id.
Find ONLY these problems: (1) repeated takes / false starts where the speaker restarts a sentence, keep the best take, (2) obvious off-topic tangents or meta talk ("wait, let me restart", "cut that").
Do NOT remove normal content, and be conservative. Reply with JSON only, no prose, no code fences:
{"remove":[{"from":<first word id>,"to":<last word id>,"reason":"<short>"}]}
Use {"remove":[]} if nothing should be removed.`;

export function buildTranscriptPrompt(words) {
  return words.map((w) => `${w.id}:${w.text}`).join(" ");
}

/** Validate Claude's answer and expand ranges to a Set of word ids. Never trust model output blindly. */
export function parseRemovals(text, words) {
  const maxId = words.length - 1;
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { ids: new Set(), reasons: [] };
  }
  const ids = new Set();
  const reasons = [];
  let removedCount = 0;
  for (const r of Array.isArray(parsed?.remove) ? parsed.remove : []) {
    const from = Number(r.from), to = Number(r.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > maxId || to < from) continue;
    removedCount += to - from + 1;
    if (removedCount > words.length * 0.4) break; // safety: never let the model delete >40% of the video
    for (let i = from; i <= to; i++) ids.add(i);
    reasons.push({ from, to, reason: String(r.reason ?? "").slice(0, 120) });
  }
  return { ids, reasons };
}

export async function smartCuts(words, { fetchImpl = fetch } = {}) {
  if (!config.anthropicKey) return { ids: new Set(), reasons: [], skipped: "no ANTHROPIC_API_KEY" };
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content: buildTranscriptPrompt(words) }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
  return parseRemovals(text, words);
}
