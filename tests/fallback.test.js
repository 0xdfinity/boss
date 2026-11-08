import { test } from "node:test";
import assert from "node:assert/strict";

// /health says which providers are configured; modelStatus says which ones
// actually answered. Without this, a key that is present but rejected looks
// healthy while every call silently falls back to the next provider.
test("model status records a failure and then a success", async (t) => {
  const { chatJSON, modelStatus } = await import("../src/ai/model.js");
  if (!modelStatus().length) return t.skip("no provider configured in this environment");

  const name = modelStatus()[0].name;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "bad key" });
    assert.equal(await chatJSON({ system: "s", user: "u" }), null);
    const failed = modelStatus().find((s) => s.name === name);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /401/);
    assert.ok(failed.at);

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "  fine  " } }] }),
    });
    const ok = await chatJSON({ system: "s", user: "u" });
    assert.equal(ok.text, "fine");
    const healthy = modelStatus().find((s) => s.name === name);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.error, undefined);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});
