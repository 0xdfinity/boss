# PRODUCT.md — BOSS

## Who, and the one job

A stranger with a task they do not want to hand to an AI on faith — a technical
founder, a reviewer, a judge with 90 seconds. The job: hand over one brief and
get work back that is either paid because it passed, or refused and the money
unmoved. Everyone else in this space asks to be trusted first.

## What it is, in one sentence

A software firm that hires AIs, judges what they hand in, and settles on NEAR —
the work passes or nobody gets paid.

## Proof (everything checkable)

- The market contract `market.boss-firm-506331.testnet` escrows 0.050 NEAR per
  job and counts released vs refunded on chain: 28 jobs, 15 released, 13
  refunded as of the last deploy. Both outcomes are public in the in-app market
  panel; refund is presented, never hidden.
- Job 23 released at 95/100 after `sha256(bytes) == result_hash`. Job 24 asked
  for a chain read; the worker declined, no claim was made, escrow refunded.
- 48 automated tests cover caps, plan rules, acceptance, RPC failover, limits.
- `docs/TRUST.md` separates what this build enforces from what is still design.
  Nothing in this repo claims zk or TEE execution.

## Constraints

- NEAR testnet today. Payments in this build are NEAR only; cross-chain is a
  direction, not a shipped bridge.
- Free-tier hosting: the service idles and spins up on first request.
- Demo caps are real: `$2.00` per agent, `$20.00` per day, two concurrent jobs.
  They are shown to the visitor, not hidden in fine print.

## Voice

- Lowercase, declarative, terse. British-neutral spelling. No exclamation
  marks, no emoji, no "unleash", "revolutionise", "seamless", "supercharge".
- Never claim what does not ship. NEAR testnet, live and countable, beats any
  adjective.

## Landing decision (one idea)

The page is the counter of a working firm, not a brochure. The visitor reads one
sentence — "the work passes, or nobody gets paid" — then uses the composer. The
page proves the trade with the live ledger instead of describing it.

## Banned on this surface

- Centered gradient pill above a hedged headline.
- Three identical icon cards in a row.
- Logos of partners nobody asked for ("trusted by").
- A "Get started" CTA that means nothing.
- Any claim without a tx link or a test behind it.

## Keep list (the soul — protected)

The wordmark `boss · NEAR`, the warm dot-grid paper, the single composer, the
`#00ec97` accent used only where money or a pass appears, the pixel mark, and
the refund story told honestly in the open.

## Damage report from the last pass

- `what needs doing?` told a stranger nothing about what BOSS is.
- The value never appeared before the composer; the meter had no context.
- The wallet path was a small pill; visitors could not tell connecting unlocks
  escrow and a scoped signing key, not another demo.
- The market panel, the product's only proof, was one click away from invisible.
