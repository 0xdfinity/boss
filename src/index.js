// BOSS CLI: node src/index.js --budget 5 --brief "write five taglines for a coffee club"
import { runJob } from "./firm/run.js";

function parseArgs(argv) {
  const args = { budget: 20, brief: "Write 5 taglines for a coffee subscription, then pick the strongest" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--budget") args.budget = Number(argv[++i]);
    if (argv[i] === "--brief" || argv[i] === "--task") args.brief = argv[++i];
  }
  return args;
}

const { budget, brief } = parseArgs(process.argv);
console.log(`BOSS job: "${brief}" (budget $${budget})\n`);

const result = await runJob({
  brief,
  budget,
  onEvent: (e) => {
    if (e.type === "firm.plan") console.log(`  plan: ${e.stages.map((s) => s.kind).join(" → ")}`);
    if (e.type === "stage.start") console.log(`  hired ${e.agent} for ${e.stage} ($${e.price})`);
    if (e.type === "verifier.attested") console.log(`  accepted ${e.stage} · ${e.confidence ? Math.round(e.confidence * 100) : "?"}/100 · ${e.mode}`);
    if (e.type === "payer.settled") console.log(`  paid $${e.amount} to ${e.worker} (${e.mode}${e.tx ? ` ${e.tx.slice(0, 12)}…` : ""})`);
    if (e.type === "proof.rejected" || e.type === "stage.rejected") console.log(`  refused ${e.agent || e.stage}: ${e.reason}`);
    if (e.type === "mission.error") console.log(`  stopped: ${e.error}`);
  },
});

console.log(`\npaid ${result.paid}, refused ${result.rejected}, spent $${Number(result.spent).toFixed(2)} of $${budget}`);
if (result.artifact) console.log(`\n--- deliverable ---\n${result.artifact}`);
