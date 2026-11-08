// Acceptance: does this delivery satisfy the spec the client published?
//
// Two layers, same as the internal pipeline. Rules first, because they are
// cheap, deterministic, and cannot be talked around. Then a model rubric for
// the part rules cannot see. A delivery must pass both to be paid.

import { finalVerdict } from "./judge.js";
import { wordCount, wordBounds, listCount, refusal, briefSpec } from "./plan.js";

/**
 * Spec shape published by a client:
 *   { brief: string, acceptance?: string[] }
 *
 * Acceptance entries are plain English, and only a few are enforced
 * deterministically. Anything else is left to the model rubric — better to
 * admit a rule is soft than to pretend it is hard.
 */
export function checkRules(spec, text) {
  const reasons = [];
  const body = String(text || "");
  const words = wordCount(body);

  if (!body.trim()) return { ok: false, reasons: ["empty delivery"] };
  if (refusal(body)) return { ok: false, reasons: ["the worker refused the task"] };

  const bounds = wordBounds(spec.brief || "");
  if (words > bounds.max) {
    reasons.push(`too long: ${words} words, limit ${bounds.max} (${bounds.why})`);
  }
  // A floor only applies when the brief actually asked for a length. A list of
  // five taglines is legitimately short, and a 40-word floor would fail it.
  const askedLength = /\d{2,4}\s+words|one[- ]page/i.test(spec.brief || "");
  if (askedLength && words < bounds.min) {
    reasons.push(`too short: ${words} words, floor ${bounds.min} (${bounds.why})`);
  }

  const items = (spec.acceptance || []).join(" ").toLowerCase();
  const countMatch = items.match(
    /(\d+)\s+(?:numbered\s+|distinct\s+)?(?:items|taglines|slogans|options|lines|bullets|checks|tests|steps|questions)/
  );
  const want = countMatch ? Number(countMatch[1]) : briefSpec(spec.brief || "").count;
  if (want > 0) {
    const got = listCount(body);
    if (got !== want) reasons.push(`asked for ${want} items, delivery has ${got}`);
  }

  const wantsSource =
    /source url|cite a source|with a link|include a (?:url|link)|with sources/.test(items) ||
    /source url|cite a source|with a source|include a (?:url|link)/i.test(spec.brief || "");
  if (wantsSource && !/https?:\/\/\S+/i.test(body)) {
    reasons.push("no source URL in the delivery, and the spec requires one");
  }

  return { ok: reasons.length === 0, reasons, words };
}

/** Rules, then the rubric. Returns a verdict the client can act on. */
export async function judgeDelivery(spec, text) {
  const rules = checkRules(spec, text);
  if (!rules.ok) {
    return { ok: false, mode: "rules", score: 0, reasons: rules.reasons, words: rules.words };
  }

  const verdict = await finalVerdict(spec.brief || "", text);
  return {
    ok: Boolean(verdict.ok),
    mode: verdict.mode,
    score: verdict.score,
    reasons: [...rules.reasons, ...(verdict.reasons || [])].slice(0, 4),
    words: rules.words,
  };
}
