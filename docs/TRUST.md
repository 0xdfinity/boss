# What BOSS enforces, and what it does not

This page separates the checks that run today from the parts that are still
design. Judges and reviewers should be able to verify every claim here against
the code.

## Enforced by the contracts

`boss_treasury` (per-payment cap, daily budget, audit log):

- the owner funds the contract; the server holds an **allowance**, not the funds
- `authorize_spend` refuses a payment above the per-payment cap or the daily budget
- every authorization is written to an on-chain audit log
- `pay` charges the allowance and transfers NEAR in the same call, for agents
  that have a registered NEAR account

`boss_market` (cross-firm escrow):

- the client deposits NEAR and publishes a spec hash
- a client cannot deliver its own job
- a submitted job cannot be settled twice
- only the client, or the optional `arbiter`, can release
- anyone can refund after the deadline, so a silent client cannot strand escrow
- a submitted-then-refunded job counts as a failure against the worker's reputation

## Enforced by the server

- deterministic acceptance rules run before any model: word bounds derived from
  the brief, the requested item count, the required pick, refusal phrases, a
  required source URL, and a Jaccard check that a revision changed the draft
- drafts and revisions then face a model rubric scored 0-100 against the brief
- a stage that fails either layer is not paid; a second candidate agent gets one
  attempt, then the job stops instead of faking the work
- the client fetches the worker's bytes over HTTP, checks
  `sha256(bytes) == result_hash`, and only then releases escrow
- per-IP and global daily limits (5 demo jobs per address, 60 per day by
  default), a concurrency limit, and a per-job USD cap

## The client is also the judge

That is normal release semantics for an escrow, but it is a real power
imbalance: a client can refuse to release a submitted job and refund itself
before the deadline. The worker's protection is the deadline (anyone can trigger
the refund) plus its on-chain reputation, not guaranteed payment. An arbiter
panel is the next step, not a thing this build claims.

## What the verdict is

The rubric is a second model opinion, not a proof. It is useful against filler,
refusals, and work that ignores the brief; it is not adversarial-proof. BOSS
does not claim zk proofs of work, and it does not claim a TEE attested a job
unless the job actually ran in one. The demo runs on Groq; `GET /health` reports
which provider answered last.

## Not built

- **Arbiter panel.** `boss_market` stores an optional arbiter account and lets it
  settle either way; selection, bonds, and majority rulings are not implemented.
- **Stake and slash.** A worker does not post a bond that a failed verdict
  forfeits.
- **Challenge window.** Accepted work settles immediately; there is no dispute
  period.
- **Cross-chain settlement.** Every payment in this build is NEAR. The tagline
  says "pays any chain"; that is the direction, not a shipped transfer.
- **Agent directory.** The registry is per-instance. There is no shared index
  with staked, portable reputation.

## Non-goals

- no leverage and no autonomous trading
- no "fraud-proof everything" claims
- no cross-chain marketplace before the single-chain loop is reliable
