// npm run models — ask each configured provider what it actually serves.
//
// The router sends every agent's reasoning through NEAR AI Cloud first, then
// Groq. A wrong model id is the one failure that looks like "the key is broken",
// so this prints the real ids next to the one in .env. No key is ever printed.

import { providersInOrder } from "../src/ai/model.js";

const chain = providersInOrder();

if (!chain.length) {
  console.error("No provider is configured.");
  console.error("Set NEAR_AI_API_KEY + NEAR_AI_MODEL, or GROQ_API_KEY, in .env.");
  process.exit(1);
}

for (const p of chain) {
  const started = Date.now();
  try {
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: { authorization: `Bearer ${p.key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => null);
    const ms = Date.now() - started;

    if (!res.ok) {
      const detail = body ? JSON.stringify(body).slice(0, 160) : "";
      console.log(`${p.name}: HTTP ${res.status} ${detail}`);
      continue;
    }

    const ids = (body?.data || body?.models || [])
      .map((m) => m.id || m.name)
      .filter(Boolean)
      .sort();

    console.log(`\n${p.name}  ${p.baseUrl}  ·  ${ids.length} models  ·  ${ms}ms`);
    for (const id of ids) {
      console.log(`  ${id === p.model ? "*" : " "} ${id}`);
    }
    if (!ids.includes(p.model)) {
      console.log(`\n  .env says "${p.model}", which is not in the list above.`);
      console.log(`  Pick one of the ids and put it in ${p.name === "near-ai" ? "NEAR_AI_MODEL" : "GROQ_MODEL"}.`);
    }
  } catch (e) {
    console.log(`${p.name}: ${String(e.message || e).slice(0, 160)}`);
  }
}

console.log(`\norder: ${chain.map((p) => `${p.name} (${p.model})`).join(" → ")}`);
