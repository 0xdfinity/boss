// The work BOSS actually sells. A brief becomes a short pipeline of stages:
// research -> draft -> critique -> revise, then a judge verdict.
//
// Each stage has a prompt, a price band, and deterministic acceptance checks.
// The checks are the part the model cannot talk its way past: word counts,
// required structure, refusal detection, and a diff against the previous stage.

export const STAGES = [
  {
    kind: "research",
    capability: "research",
    title: "Research brief",
    price: 0.35,
    prompt: (brief) => ({
      system:
        "You are a research agent inside BOSS, a software firm. You are terse and concrete. " +
        "Never mention being an AI. Never pad. Output plain text, no markdown headings. " +
        "You produce internal notes only: never write the client's deliverable, copy, or taglines.",
      user:
        `Client brief: ${brief}\n\n` +
        "Produce, in under 180 words:\n" +
        "1. The audience and what they actually want.\n" +
        "2. Five decision-relevant facts or assumptions (mark assumptions as such).\n" +
        "3. Three hard constraints the deliverable must respect.\n\n" +
        "Do not draft the deliverable. Do not write slogans, taglines, emails or copy. Notes only.",
    }),
    check: (text) => {
      const words = wordCount(text);
      if (words < 50) return { ok: false, reason: `research too thin (${words} words)` };
      if (words > 320) return { ok: false, reason: `research too long (${words} words)` };
      if (refusal(text)) return { ok: false, reason: "agent refused the task" };
      const says = /audience|constraint|assumption/i.test(text);
      if (!says) return { ok: false, reason: "research missing audience/constraints" };
      return { ok: true, reason: `${words} words, structure present` };
    },
  },
  {
    kind: "draft",
    capability: "draft",
    title: "First draft",
    price: 0.9,
    prompt: (brief, prior) => {
      return {
        system:
          "You are a senior writer inside BOSS. You write the deliverable the client asked for, " +
          "not commentary about it. Plain text. No preamble. No 'as an AI'.",
        user:
          `Client brief: ${brief}\n\nResearch brief:\n${prior}\n\n` +
          `Write the deliverable now. ${writingRule(brief)} ` +
          `${lengthInstruction(brief)} ` +
          "If the brief asks for a list, return the list; if it asks for copy, return the copy only.",
      };
    },
    check: (text, prior, critique, brief) => {
      if (similarity(text, prior) > 0.75) return { ok: false, reason: "draft just repeats the research" };
      const bounds = wordBounds(brief);
      const words = wordCount(text);
      if (words < bounds.min) return { ok: false, reason: `draft too short (${words} words, ${bounds.why})` };
      if (words > bounds.max) return { ok: false, reason: `draft too long (${words} words, ${bounds.why})` };
      if (refusal(text)) return { ok: false, reason: "agent refused the task" };
      // "Specifics" means numbers, names, or list structure. A short rewrite or
      // a hard word cap has no room for those and must not be failed for it.
      if (wantsSpecifics(brief) && !/\d|•|^-|\n\s*[-*]/m.test(text) && words < 80) {
        return { ok: false, reason: "draft has no specifics" };
      }
      const shape = checkShape(text, brief);
      if (!shape.ok) return shape;
      return { ok: true, reason: `${words} words, original` };
    },
  },
  {
    kind: "critique",
    capability: "critique",
    title: "Red-team review",
    price: 0.45,
    prompt: (brief, prior) => ({
      system:
        "You are a ruthless editor. You find the weakest parts of a draft and give exact fixes. " +
        "You never rewrite the whole thing. Plain text.",
      user:
        `Client brief: ${brief}\n\nDraft:\n${prior}\n\n` +
        "Score the draft 1-5 on clarity, specificity, and usefulness. " +
        "Then list the three weakest lines with the exact fix for each. Under 170 words.",
    }),
    check: (text) => {
      const words = wordCount(text);
      if (words < 40) return { ok: false, reason: `critique too thin (${words} words)` };
      if (refusal(text)) return { ok: false, reason: "agent refused the task" };
      const hits = ["clarity", "specific", "useful", "weak", "fix", "score"].filter((k) =>
        text.toLowerCase().includes(k)
      ).length;
      if (hits < 2) return { ok: false, reason: "critique is not actionable" };
      return { ok: true, reason: `${words} words, ${hits} rubric signals` };
    },
  },
  {
    kind: "revise",
    capability: "revise",
    title: "Final artifact",
    price: 0.8,
    prompt: (brief, prior, critique) => {
      return {
        system:
          "You are the editor. You apply the critique and return only the finished artifact. " +
          "No notes, no explanation, no markdown headings unless the brief asks for them. " +
          "Preserve the structure the brief requires: if it asks for a numbered list of N items, " +
          "return exactly N numbered items; if it asks for a pick, name the pick at the end.",
        user:
          `Client brief: ${brief}\n\nDraft:\n${prior}\n\nCritique to apply:\n${critique}\n\n` +
          `${writingRule(brief)} ` +
          `${lengthInstruction(brief)} ` +
          "Return the final deliverable only. Keep the brief's shape exactly: " +
          "same number of items, same list format, and the single strongest pick if one was requested. " +
          "Apply the critique line by line; do not rewrite the whole thing into paragraphs.",
      };
    },
    check: (text, prior, critique, brief) => {
      const bounds = wordBounds(brief);
      const words = wordCount(text);
      if (words < bounds.min) return { ok: false, reason: `final artifact too short (${words} words, ${bounds.why})` };
      if (words > bounds.max) return { ok: false, reason: `final artifact too long (${words} words, ${bounds.why})` };
      if (refusal(text)) return { ok: false, reason: "agent refused the task" };
      if (jaccard(text, prior) > 0.995) return { ok: false, reason: "critique was not applied" };
      // A rewrite must keep the draft's substance; applying critique is editing,
      // not deleting everything that was not praised.
      if (isRewrite(brief)) {
        const floor = Math.max(bounds.min, Math.round(wordCount(prior) * 0.6));
        if (words < floor) {
          return { ok: false, reason: `revision dropped most of the draft (${words} words, floor ${floor})` };
        }
      }
      const shape = checkShape(text, brief);
      if (!shape.ok) return shape;
      return { ok: true, reason: `${words} words, revised` };
    },
  },
];

export function planStages(brief) {
  return STAGES.map((s, i) => ({
    id: `stage-${i + 1}`,
    ...s,
    brief,
  }));
}

/**
 * What the brief explicitly demands, in a form the rules can check. The model
 * cannot talk its way past "the client asked for five, you returned four".
 */
export function briefSpec(brief) {
  const text = String(brief || "");
  const m = text.match(
    /\b(\d+)\s+(?:distinct\s+|short\s+|different\s+|new\s+|numbered\s+)?(taglines|slogans|options|names|ideas|headlines|bullets|lines|variations|checks|tests|steps|questions)\b/i
  );
  const count = m ? Number(m[1]) : 0;
  const wantsPick = /pick the strongest|choose the (?:best|strongest)|best option|strongest (?:one|option|tagline)/i.test(text);
  return { count, wantsPick };
}

/** How many numbered or bulleted items the text contains. */
export function listCount(text) {
  const lines = String(text || "").split(/\r?\n/);
  return lines.filter((l) => /^\s*(?:\d+[.)]|[-*•])\s+\S/.test(l)).length;
}

/** A word limit the brief states explicitly ("cut it to 60 words", "under 120 words"). */
export function targetWords(brief) {
  const m = String(brief || "").match(/\b(?:to|under|max(?:imum)?|at most|in|within)\s+(\d{2,4})\s+words\b/i);
  return m ? Number(m[1]) : 0;
}

/**
 * True when the stated count is a ceiling ("cut it to 60 words", "under 120
 * words") rather than an exact target. A ceiling must not force padding: the
 * honest answer to "cut this to 60 words" can be 20 good ones.
 */
export function isWordCap(brief) {
  return /\b(?:cut it to|cut to|under|fewer than|less than|max(?:imum)?|at most|no more than|within)\s+\d{2,4}\s+words\b/i.test(
    String(brief || "")
  );
}

/**
 * Short-copy or rewrite briefs have no room for numbers or list structure, so
 * the "specifics" rule must stand down for them or it fails correct work.
 */
export function wantsSpecifics(brief) {
  const text = String(brief || "");
  if (targetWords(text)) return false;
  if (isRewrite(text)) return false;
  return true;
}

/** A brief that transforms existing text rather than commissioning new facts. */
export function isRewrite(brief) {
  return /\b(rewrite|plain english|shorten|summari[sz]e|condense|tighten|cut it to|translate)\b/i.test(
    String(brief || "")
  );
}

/**
 * The one line that decides whether the writer invents facts. A rewrite must
 * preserve meaning; anything else must earn its place with specifics.
 */
function writingRule(brief) {
  if (isRewrite(brief)) {
    return (
      "This is a rewrite: keep every claim the original makes, in complete sentences, " +
      "invent no numbers, clients, or results, and cut only jargon. " +
      "Never compress into fragments or delete the original's substance."
    );
  }
  return "Make it specific: concrete nouns, checkable numbers, and no filler.";
}

/**
 * The length sentence handed to a writer. A cap and a target need different
 * instructions, or the model pads to hit a minimum nobody asked for.
 */
export function lengthInstruction(brief) {
  const b = wordBounds(brief);
  if (isWordCap(brief)) {
    return `Length: at most ${b.max} words (${b.why}); shorter is fine, padding is not.`;
  }
  return `Length: ${b.min}-${b.max} words (${b.why}); land inside that range.`;
}

/** Bounds for an artifact, derived from the brief rather than assumed. */
export function wordBounds(brief) {
  const target = targetWords(brief);
  const onePage = /\b(one|1)[- ]page\b/i.test(String(brief || ""));
  if (target && isWordCap(brief)) {
    return {
      min: Math.max(5, Math.round(target * 0.1)),
      max: Math.round(target * 1.1),
      why: `${target}-word cap`,
    };
  }
  if (target) {
    return {
      min: Math.round(target * 0.8),
      max: Math.round(target * 1.2),
      why: `${target}-word target`,
    };
  }
  if (onePage) return { min: 60, max: 620, why: "one-page limit" };
  return { min: 40, max: 1200, why: "default length" };
}

/** The brief's explicit shape, enforced on the artifacts the client sees. */
function checkShape(text, brief) {
  const spec = briefSpec(brief);
  if (spec.count > 1) {
    const got = listCount(text);
    if (got < spec.count) {
      return { ok: false, reason: `brief asked for ${spec.count} items, got ${got}` };
    }
  }
  if (spec.wantsPick && !/\b(strongest|best|pick|winner|recommend)\b/i.test(text)) {
    return { ok: false, reason: "brief asked for one pick, none found" };
  }
  return { ok: true };
}

export function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

export function refusal(text) {
  return /\b(as an ai|i am an ai|i cannot|i can't|i'm unable|i am unable|sorry, but i)\b/i.test(String(text));
}

export function similarity(a, b) {
  const tokens = (t) =>
    new Set(
      String(t || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * Jaccard overlap: shared words over the union. Use this to tell "the text
 * changed" from "the text is the same", because similarity() above scores any
 * superset at 1.0 and a correct minimal edit is a superset.
 */
export function jaccard(a, b) {
  const tokens = (t) =>
    new Set(
      String(t || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * The client receives text, not markdown. Models still emit **bold** and #
 * headings, which look like typos in a plain-text deliverable, so strip the
 * markers without touching the words or any code the client asked for.
 */
export function toPlainText(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+\*\*(.+?)\*\*/gm, "- $1")
    .trim();
}

export function artifactHint(brief) {
  const t = String(brief).toLowerCase();
  if (/tagline|slogan|name/.test(t)) return "a set of named options plus the strongest pick and why";
  if (/check|acceptance|release|escrow|refund/.test(t)) return "a numbered checklist the other side can run without trusting the firm";
  if (/plan|launch|roadmap|strategy/.test(t)) return "a one-page plan with owners and a first-week checklist";
  if (/summar|bullet|digest/.test(t)) return "a short summary with bullets, no filler";
  if (/review|critique|feedback/.test(t)) return "a rubric-based review with specific fixes";
  if (/email|outreach|cold/.test(t)) return "ready-to-send copy with subject line and body";
  if (/translate|french|german|spanish/.test(t)) return "the translated text only";
  return "the finished work product, ready to hand to the client";
}
