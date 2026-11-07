// npm run model:check — one tiny completion through the real router.
//
// `npm run models` lists what a key *can* reach. This proves what it actually
// answers with, which is the failure that matters: a key that lists a model but
// is refused by it, or a model that rejects JSON mode, looks configured and then
// falls back to Groq on every single call.
//
// No key is read into the output. Only the provider name, model id, and the
// error string a provider returned.

import { chatJSON, modelStatus, providersInOrder } from "../src/ai/model.js";

const chain = providersInOrder();
if (!chain.length) {
  console.error("No provider is configured.");
  console.error("Set NEAR_AI_API_KEY + NEAR_AI_MODEL, or GROQ_API_KEY, in .env.");
  process.exit(1);
}

console.log(`order: ${chain.map((p) => `${p.name} (${p.model})`).join(" -> ")}`);

const reply = await chatJSON({
  system: 'Reply with JSON only, exactly this shape: {"ok": true, "note": "ready"}',
  user: "health check",
  maxTokens: 200,
  temperature: 0,
});

console.log();
for (const s of modelStatus()) {
  const verdict = s.ok === true ? "ok" : s.ok === false ? `failed - ${s.error}` : "not tried";
  console.log(`  ${s.name.padEnd(8)} ${s.model}  ${s.ms != null ? s.ms + "ms  " : ""}${verdict}`);
}

if (!reply) {
  console.log("\nNo provider answered. Every agent would fall back to rules-only, and the firm pays nothing.");
  process.exit(1);
}

console.log(`\nanswered: ${reply.provider} (${reply.model})`);
console.log(`reply:    ${reply.text.slice(0, 200)}`);
if (reply.provider !== chain[0].name) {
  console.log(`\nNote: the first provider did not answer, so this call used ${reply.provider}.`);
  console.log("That is a working fallback, not a working primary. Fix the line above it.");
}
