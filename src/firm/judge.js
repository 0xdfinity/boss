// The judge. Two layers, cheapest first:
//   1. rules  — deterministic checks the model cannot argue with
//   2. rubric — a second model pass that scores the work against the brief
//
// A stage is paid only when both layers that could run, ran and passed. If no
// model is configured, the verdict says `rules` so nobody mistakes it for a
// model review.
//
// The rubric runs in JSON mode, which makes some models confuse "reply in JSON"
// with "the deliverable must be JSON". The prompt says plainly that the
// deliverable is prose and only the verdict is JSON; without that line the
// judge rejects perfectly good copy for "not being JSON".

import { chatJSON } from "../ai/model.js";
import { wordBounds, wordCount, isRewrite, isWordCap } from "./plan.js";

const RUBRIC =
  "You are the client's acceptance judge. You are hard to impress but fair.\n" +
  "The deliverable under review is plain prose. Only YOUR reply is JSON. " +
  "Never reject work for not being JSON unless the brief explicitly asked for JSON.\n" +
  'Reply with exactly this shape: {"pass": boolean, "score": number, "reasons": [string, string, string]}\n' +
  "score is 0-100. pass only if the deliverable could be used as-is by the client. " +
  "Reward specificity, completeness, and obedience to the brief. " +
  "Punish filler, refusal, invented facts presented as verified, and ducking the ask.";

/**
 * A judge that is not told the brief's tolerance fails a 61-word answer to a
 * 60-word cap. State the bounds and the rewrite rule explicitly so the model
 * judges the work, not an imaginary stricter spec.
 */
function lengthRule(brief, deliverable) {
  const bounds = wordBounds(brief);
  const words = wordCount(deliverable);
  const inside = words >= bounds.min && words <= bounds.max;
  const cap = isWordCap(brief);
  const lines = [
    `Length rule: the client's acceptance bounds for this brief are ${bounds.min}-${bounds.max} words ` +
      `(${bounds.why}). The deliverable is ${words} words, so ` +
      `${inside ? "it is within bounds" : "it is outside bounds"}. ` +
      (cap
        ? "The stated count is a maximum: a shorter answer is correct, padding to reach it is not.\n"
        : "The stated count is a target: landing near it matters.\n"),
  ];
  if (isRewrite(brief)) {
    lines.push(
      "This is a rewrite: the only acceptable facts are the ones in the original text. " +
        "Inventing numbers, clients, or results is a serious failure; rewriting cleanly is not.\n"
    );
  }
  return lines.join("");
}

/**
 * Models return scores as "85", "85/100", "8.5/10", or "85%". Reading those as
 * plain numbers turns a passing verdict into a zero, so normalise first.
 */
export function parseScore(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, value));
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  const ratio = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (ratio) {
    const denom = Number(ratio[2]);
    if (denom > 0) return Math.max(0, Math.min(100, (Number(ratio[1]) / denom) * 100));
  }
  const num = text.match(/-?\d+(?:\.\d+)?/);
  if (!num) return null;
  return Math.max(0, Math.min(100, Number(num[0])));
}

/**
 * Some models emit one array element with the separators left inside it:
 * `["a","b","c"]` arrives as `["a\",\"b\",\"c"]`. Valid JSON, useless reasons.
 * Split those back out, drop stray brackets/quotes, and keep the first few.
 */
export function normaliseReasons(value, limit = 3) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list
    .flatMap((item) => String(item).split('","'))
    .map((item) => item.replace(/^[\s"'\[]+|[\s"'\]]+$/g, "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

export async function judgeStage(stage, deliverable, context = {}) {  const det = stage.check ? stage.check(deliverable, context.prior, context.critique, stage.brief) : { ok: true, reason: "no rules" };
  if (!det.ok) {
    return { ok: false, mode: "rules", score: 0, reasons: [det.reason] };
  }

  // Only the artefacts the client actually receives get a model review; the
  // research and critique stages are internal and stay on rules.
  if (stage.kind !== "draft" && stage.kind !== "revise") {
    return { ok: true, mode: "rules", score: 78, reasons: [det.reason] };
  }

  const reply = await chatJSON({
    system: RUBRIC,
    user:
      `The client's brief: ${stage.brief}\n\n` +
      "What should count as done: the deliverable must satisfy the brief directly.\n\n" +
      lengthRule(stage.brief, deliverable) +
      "The deliverable (plain prose):\n" +
      deliverable,
    temperature: 0,
    maxTokens: 400,
  });
  if (!reply) {
    return { ok: true, mode: "rules", score: 72, reasons: [det.reason, "no model available — rules only"] };
  }

  try {
    const parsed = JSON.parse(reply.text);
    const saidPass = parsed.pass !== false;
    const parsedScore = parseScore(parsed.score);
    // A pass with an unreadable score is a pass: the model already judged it.
    const score = parsedScore ?? (saidPass ? 75 : 0);
    const pass = saidPass && score >= 55;
    return {
      ok: pass,
      mode: reply.provider,
      score,
      reasons: [
        det.reason,
        ...normaliseReasons(parsed.reasons),
      ],
    };
  } catch {
    return { ok: true, mode: "rules", score: 70, reasons: [det.reason, `${reply.provider} returned unparseable JSON`] };
  }
}

/** Final gate: would a client accept this whole job? */
export async function finalVerdict(brief, artifact) {
  const reply = await chatJSON({
    system:
      "You are the client signing off on a completed job. The deliverable is plain prose; only your reply is JSON. " +
      'Reply with exactly {"pass": boolean, "score": number, "reasons": [string, string, string]}. ' +
      "score is 0-100. Be hard to impress, but judge the work against the brief, not its formatting.",
    user:
      `Brief: ${brief}\n\n` +
      lengthRule(brief, artifact) +
      `Delivered (plain prose):\n${artifact}`,
    temperature: 0,
    maxTokens: 400,
  });
  if (!reply) return { ok: true, mode: "rules", score: 75, reasons: ["no model configured — accepted on rules"] };
  try {
    const p = JSON.parse(reply.text);
    const saidPass = p.pass !== false;
    const parsedScore = parseScore(p.score);
    const score = parsedScore ?? (saidPass ? 75 : 0);
    return {
      ok: saidPass && score >= 55,
      mode: reply.provider,
      score,
      reasons: normaliseReasons(p.reasons),
    };
  } catch {
    return { ok: true, mode: "rules", score: 70, reasons: [`${reply.provider} returned unparseable JSON`] };
  }
}
