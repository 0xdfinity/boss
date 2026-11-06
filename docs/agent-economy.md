# BOSS: what is enforced, and what comes next

Written 2026-11-06. This note separates what the code does today from the parts
that are still design.

## What ships now

- **A fixed job shape.** A brief becomes research → draft → critique → revise,
  each stage hired and paid separately.
- **Two-layer verification.** Deterministic rules run first: word bounds from the
  brief, the requested item count, the required pick, refusal phrases, and a
  Jaccard check that the revision actually changed the draft. Drafts and
  revisions then face a model rubric scored 0–100 against the brief.
- **Payment gated on the verdict.** A rejected stage pays nothing. The orchestrator
  either tries the next candidate agent or stops the job.
- **Caps in the contract.** `boss_treasury` enforces a per-payment cap and a daily
  budget on-chain, keeps an audit log, and owns the funds. The server holds an
  agent allowance, not the treasury.
- **Real transfers to outside agents.** An agent registered by URL with a NEAR
  account is paid through the contract's `pay` method, which charges its allowance
  and transfers NEAR in the same call. In-house agents are salaried through
  `authorize_spend` and audited on the same ledger.

## What is honest to say about verification

The rubric is a second model opinion, not a proof. It is useful against filler,
refusals, and work that ignores the brief; it is not adversarial-proof. BOSS does
not claim zk proofs of work, and it does not claim a TEE attested a job unless the
job actually ran in one.

## Next: make the verdict costly to fake

1. **Stake and slash.** A worker posts a bond before claiming a stage. A failed
   verdict forfeits it to the treasury. This turns the verdict from an opinion
   into an economic decision.
2. **Challenge window.** Accepted work stays pending for a fixed window. Anyone
   can challenge with counter-evidence; a staked panel rules, and the loser pays.
3. **Attestations where they are real.** If a stage runs inside NEAR AI Cloud,
   attach the TEE attestation and let anyone check it against the measurement.
   Where it does not, say so.
4. **Cross-chain settlement.** The treasury pays NEAR today. NEAR Intents is the
   path for paying an agent on Base or Ethereum without it owning a NEAR account;
   the adapters exist but are not wired into the payout path yet.
5. **Agent directory.** Registry entries with capability, price, reputation, and
   stake, so hiring is a market rather than a hardcoded list.

## Non-goals

- No leverage and no autonomous trading.
- No "fraud-proof everything" claims.
- No cross-chain marketplace before the single-chain loop is reliable.
