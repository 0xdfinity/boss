// Dry run: the full firm pipeline with a fake treasury, so prompt and check
// changes can be iterated without spending testnet NEAR.
//
//   node scripts/dryrun.mjs "your brief"
//
// Prints every stage's verdict and the actual deliverable, plus the exact
// rejection reason. Uses the real model chain.

import { runJob } from "../src/firm/run.js";

const brief = process.argv.slice(2).join(" ") || "Write 5 taglines for a coffee subscription, then pick the strongest";

const ledger = {
  calls: [],
  async authorize(input) {
    this.calls.push(input);
    return { ok: true, mode: "mirror", tx: null, url: "" };
  },
};

const t0 = Date.now();
const result = await runJob({
  brief,
  budget: 20,
  deps: { treasury: ledger },
  onEvent: (e) => {
    if (e.type === "firm.plan") console.log(`plan: ${e.stages.map((s) => s.kind).join(" → ")}`);
    if (e.type === "stage.start") console.log(`\n> ${e.stage} · ${e.agent} · $${e.price}`);
    if (e.type === "proof.rejected") {
      console.log(`  REJECTED ${e.stage} (${e.agent}): ${e.reason} [${e.mode} ${e.confidence}]`);
      console.log(`  reasons: ${(e.reasons || []).join(" | ")}`);
      console.log(`  sample: ${String(e.sample || "").replace(/\s+/g, " ").slice(0, 500)}`);
    }
    if (e.type === "stage.rejected") console.log(`  REJECTED ${e.stage} (${e.agent}): ${e.reason}`);
    if (e.type === "verifier.attested") console.log(`  accepted · ${Math.round(e.confidence * 100)}/100 · ${e.mode} · ${e.reasons.slice(0, 2).join(" | ")}`);
    if (e.type === "mission.error") console.log(`\nSTOPPED: ${e.error}`);
  },
});

console.log("\n================ stages ================");
for (const s of result.stages) {
  console.log(`\n--- ${s.kind} · ${s.agent} · ${s.verdict.score}/100 [${s.verdict.mode}] ---`);
  console.log(s.deliverable);
}
console.log("\n================ result ================");
console.log(`paid ${result.paid} · rejected ${result.rejected} · spent $${result.spent} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`verdict: ${JSON.stringify(result.verdict)}`);
if (result.error) console.log(`ERROR: ${result.error}`);
