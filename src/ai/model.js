// Model router — NEAR AI Cloud first, Groq as fallback, local deterministic last.
// One router for every agent that needs a brain.
//
// Two shapes, because the two callers need different things:
//   chatText  — prose deliverables (draft, critique, revision)
//   chatJSON  — verdicts and scores (judge, acceptance)
// Forcing json_object on a prose call returns a JSON-wrapped artifact, which is
// exactly the kind of silent breakage that ruins a demo, so the shapes are
// separate functions rather than a flag nobody remembers to set.
import { env } from "../config/env.js";

export function providersInOrder() {
  const chain = [];
  if (env.nearAiKey && env.nearAiModel) {
    chain.push({ name: "near-ai", baseUrl: `${env.nearAiBaseUrl}/v1`, key: env.nearAiKey, model: env.nearAiModel });
  }
  if (env.groqKey) {
    chain.push({ name: "groq", baseUrl: env.groqBaseUrl, key: env.groqKey, model: env.groqModel });
  }
  return chain;
}

const TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 45_000);

async function run({ system, user, temperature = 0, json = false, maxTokens = 900 }) {
  const errors = [];

  for (const p of providersInOrder()) {
    try {
      const body = {
        model: p.model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      if (json) body.response_format = { type: "json_object" };
      // gpt-oss models spend tokens thinking before answering; keep it low so a
      // four-stage job finishes while the client is still watching.
      if (/gpt-oss/.test(p.model)) body.reasoning_effort = process.env.GROQ_REASONING_EFFORT || "low";

      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${detail.slice(0, 120)}`.trim());
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error("empty completion");
      return { text: text.trim(), provider: p.name, model: p.model };
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }

  if (errors.length) console.warn(`[model] all providers failed — ${errors.join(" | ")}`);
  return null;
}

/** Free prose. */
export function chatText(input) {
  return run({ ...input, json: false });
}

/** Strict JSON object. Callers still parse defensively. */
export function chatJSON(input) {
  return run({ ...input, json: true });
}
