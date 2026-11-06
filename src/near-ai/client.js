// Proof verifier — Privacy & Private AI track.
// Checks a worker's evidence and returns only the verdict.
// Chain: NEAR AI Cloud (TEE) → Groq (fallback) → local deterministic verdict.
import { chatJSON } from "../ai/model.js";

export const UNUSABLE = /blurry|unreadable|missing|blank|none supplied/i;

export function localVerdict(taskId, imageRef) {
  if (UNUSABLE.test(String(imageRef || ""))) {
    return {
      ok: false,
      taskId,
      confidence: 0.21,
      teeAttested: false,
      mode: "local-demo",
      reason: "photo unusable — no proof, no payment",
    };
  }
  return {
    ok: true,
    taskId,
    confidence: 0.97,
    teeAttested: false,
    mode: "local-demo",
    note: "set NEAR_AI_API_KEY (or GROQ_API_KEY) for a model verdict",
  };
}

const SYSTEM =
  'You verify photo proof of a completed field task. The worker image is private. ' +
  'Reply only with JSON: {"ok":boolean,"confidence":number,"reason":string}. ' +
  'A blurry/unusable/missing image means ok=false.';

export async function verifyProof({ taskId, imageRef, evidence }) {
  const ref = imageRef || evidence || "none supplied";

  const attempted = await chatJSON({
    system: SYSTEM,
    user: `Task ${taskId}. Evidence: ${ref}`,
    temperature: 0,
  });

  if (!attempted) {
    return { ...localVerdict(taskId, ref), note: "every model provider failed — local verdict" };
  }

  try {
    const parsed = JSON.parse(attempted.text);
    return {
      ok: !!parsed.ok,
      taskId,
      confidence: Number(parsed.confidence ?? 0),
      teeAttested: attempted.provider === "near-ai",
      mode: attempted.provider,
      reason: parsed.reason || undefined,
    };
  } catch {
    return { ...localVerdict(taskId, ref), note: `${attempted.provider} returned unusable JSON — local verdict` };
  }
}
