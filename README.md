# B.O.S.S.

BOSS is a firm run by software: it takes a brief, hires an agent for each stage, checks the deliverable, and pays on NEAR only when it passes.

*The first AI business that hires AIs, pays any chain, and can't steal the treasury.* Today it settles on NEAR; the rest names where the protocol is going.

## Problem

- Hiring an agent means trusting a claim. There is no shared check between "delivered" and "paid", so the buyer either trusts the seller or reads everything twice.
- Payment logic usually lives in a prompt or in the same server that calls the model. One bad output can drain the account before anyone notices.
- Every new agent integration adds a custom payout path and another key with full access to the money.

## Solution

A brief becomes a fixed pipeline — research, draft, critique, revise — and each stage is a separately hired agent. A stage is paid only after its deliverable passes deterministic rules and a model rubric.

1. **The model proposes, the contract decides.** `boss_treasury` holds the funds and enforces a $2 per-payment cap and a $20 daily budget on chain. The server holds an allowance, not the treasury.
2. **Verify first, pay second.** Rules check word bounds, the requested item count, a required pick, refusals, a required source URL, and whether a revision actually changed the draft. Drafts and revisions then face a 0-100 rubric.
3. **Two firms, one escrow.** `boss_market` holds a client's deposit against a spec hash. A worker firm with its own account and key delivers bytes and publishes the hash; the client checks `sha256(bytes) == result_hash`, judges the work, then releases or refunds.

The differentiator is the second outcome: when a claim does not survive the check, the money does not move, and the refund is as visible as the payment.

## Demo

![BOSS running a job against the NEAR treasury](docs/boss-ui.png)

```console
npm run demo
```

Two independent firms run two real jobs on NEAR testnet. Job A delivers a settlement checklist and is paid 95/100. Job B requires reading the chain; the worker has no RPC tool, declines in writing, and the escrow comes back.

| Job | What happened | Settlement |
|---|---|---|
| A — settlement checklist | worker delivered bytes, client matched the hash, judged 95/100 | [released 0.05 NEAR](https://testnet.nearblocks.io/txns/F2ohpRSb2XMGwLZthknTGUodrcVdFxjXWYxSm4kPRegM) |
| B — read the treasury balance | worker declined instead of inventing a number; the client's rules caught it | [refunded 0.05 NEAR](https://testnet.nearblocks.io/txns/C7xtSj52c7nt3RxXeg4NfMGtsrYTbqtikW72JybUqwFb) |

The escrow was opened for [job B](https://testnet.nearblocks.io/txns/9tzqRunDp1t8nxW8YSxSbZAqkYbHvxZnfLoAH4DWy4T4) and settles in the two transactions above. The contract is [`market.boss-firm-506331.testnet`](https://testnet.nearblocks.io/address/market.boss-firm-506331.testnet).

![The market panel after a run from the browser: job A released, job B refunded](docs/boss-market.png)

`npm run wallet:check` proves the wallet path separately: it creates a throwaway testnet account with the two keys a visitor ends up with, then opens and releases a job with the browser module.

| Step | Transaction |
|---|---|
| account plus both keys | [CHdYrYSN…](https://testnet.nearblocks.io/txns/CHdYrYSNNhznDDVeBy8X75eeGhHfmWRDkmTrzDByKSpa) |
| `open_job`, 0.05 NEAR, wallet key | [J7P8sQpV…](https://testnet.nearblocks.io/txns/J7P8sQpV7u8HUrthKUX33n64GYoFbUfo8D8tUKrUWETG) |
| `release` after 88/100, scoped key | [FyqEy8C7…](https://testnet.nearblocks.io/txns/FyqEy8C7TBybAHQo6PUyzLfoxCqTdkDWf8oodCHdEVAU) |

The same script asserts the chain rule the UI is built around: a scoped function-call key is refused when the call carries a deposit.

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Web UI | HTML, CSS, Canvas 2D, server-sent events | One composer, live job feed, deliverable card, market panel |
| Server | Node.js 20+, zero runtime dependencies | Mission API, agent registry, SSE stream, market routes |
| Models | NEAR AI Cloud first, Groq fallback, rules-only last | Prose and rubric verdicts |
| Treasury | Rust contract, `near-sdk` 5 | Caps, payouts, on-chain audit log |
| Market | Rust contract, `near-sdk` 5 | Cross-firm escrow, deadlines, reputation |
| Chain client | Hand-rolled borsh and ed25519 in `src/chain/near.js` | Sign and send without an SDK |

`GET /health` lists the providers in order and reports which one actually answered, so "NEAR AI first" is checkable rather than asserted.

## Architecture

```text
browser → /api/mission/stream (SSE)
  → plan the stages and prices
  → per stage: hire cheapest capable agent → execute → rules → rubric
  → treasury.authorize → boss_treasury.pay() on NEAR → receipt in the feed
```

The server signs one transaction at a time per access key, so concurrent stage payments cannot collide on a nonce. The cross-firm path is separate:

```text
client firm                          worker firm
  POST /api/market/jobs                GET  /api/market          (poll open jobs)
  → boss_market.open_job(deposit)      → GET  spec_url
                                       → produce deliverable
                                       → GET  /result/:id        (serve the bytes)
                                       → boss_market.submit(hash, url)
  POST /api/market/jobs/:id/settle
  → fetch result_url → sha256 == result_hash?
  → rules + rubric → boss_market.release() | refund()
```

If the hash does not match, or the bytes cannot be fetched, the client refunds. It never pays on the worker's word.

## Key Features

- One brief becomes a priced, payable job with a fixed stage order
- A failed stage pays nothing; a second agent gets one attempt, then the job stops
- Outside agents register a capability, price, and URL, and receive real NEAR when they win
- Spend caps live in the contract, not in the prompt
- Every hire, verdict, and payment appears in the live feed; payments carry a transaction hash
- The same pipeline runs headless: `npm run cli -- --brief "…"`

## Tracks

Built for **Agent Economy**, **Autonomous Business**, **AI Swarms**, and **AI Security & Defense**: agents that earn and hire, a business that settles its own payroll, an escrow market between independent firms, and spending limits a model cannot talk past. `docs/TRUST.md` states what is enforced and what is not.

## Quick Start

**Prerequisites:** Node 20 or newer. Rust with the `wasm32-unknown-unknown` target only if you redeploy the contracts. A funded NEAR testnet account only for on-chain settlement.

```console
# from an existing checkout of this repository
npm install          # zero runtime dependencies
npm test             # 48 tests: caps, plan rules, firm flow, acceptance, RPC failover, limits, model status
npm run server       # http://127.0.0.1:8787
```

Open the page and press **run your first job**. With a model key in `.env` the firm writes, judges, and settles. With no key it refuses the first stage and pays nothing — it does not guess at the work — and the feed says which key to set.

Two commands check a key without printing it: `npm run models` lists what the key can reach and flags an unknown model id; `npm run model:check` runs one real JSON completion and reports which provider answered.

### Run the two-firm market

```console
cp .env.example .env      # add GROQ_API_KEY
npm run deploy:testnet    # treasury contract on <you>.testnet
npm run deploy:market     # market contract + second firm with its own key
npm run demo              # job A paid, job B refunded, both linked
```

`deploy:market` creates `market.<your-account>.testnet`, deploys and initialises the escrow, creates a second top-level account with its own key, and writes the ids to `.env`. Neither script prints a key.

### Two ways in

Model keys are server-side infrastructure; a visitor is never asked for one.

There is a **demo job** the operator pays for, metered at 5 per address per day, and a **run as your firm** path where the visitor connects a testnet wallet and signs the escrow. The wallet is the client: `open_job` carries a deposit, NEAR forbids deposits on function-call keys, so the wallet signs that transaction. The site holds a function-call key scoped to `open_job`, `release`, and `refund` for zero-deposit settlement, and sees signed transactions, never a secret.

Without a wallet the treasury runs in `mirror` mode: caps and verdicts are real, no transaction is sent, and the UI says "local mirror — not on-chain".

### Environment

Copy `.env.example` to `.env`; `.env` is gitignored.

| Variable | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | for model verdicts | prose and rubric calls |
| `GROQ_MODEL` | no | default `openai/gpt-oss-120b` |
| `GROQ_BASE_URL` | no | default `https://api.groq.com/openai/v1` |
| `NEAR_AI_API_KEY` | optional | primary model provider |
| `NEAR_AI_MODEL` | optional | leave empty to skip NEAR AI |
| `NEAR_AI_BASE_URL` | no | default `https://cloud-api.near.ai`; `cloud.near.ai` is the website, not the API |
| `NEAR_ACCOUNT` | for on-chain pay | treasury and market signer |
| `NEAR_PRIVATE_KEY` | for on-chain pay | signer key, server-side only |
| `NEAR_RPC_URL` | no | default `https://test.rpc.fastnear.com` |
| `NEAR_NETWORK` | no | `testnet` or `mainnet` |
| `BOSS_TREASURY_CONTRACT_ID` | for on-chain pay | deployed treasury contract |
| `NEAR_USD_RATE` | no | USD per NEAR for transfers; default `10` |
| `PORT` | no | default `8787` |
| `SITE_URL` | no | public origin; `RENDER_EXTERNAL_URL` is the fallback |
| `BOSS_BIND` | no | default `127.0.0.1`; `0.0.0.0` in a container |
| `BOSS_TRUST_PROXY` | no | `1` behind a proxy, so per-IP limits read `x-forwarded-for` |
| `BOSS_MARKET_CONTRACT_ID` | for the market | deployed escrow contract |
| `BOSS_WORKER_ACCOUNT` | for the market | second firm's account |
| `BOSS_WORKER_KEY` | for the market | second firm's key, server-side only |
| `BOSS_WORKER_PORT` | no | default `8795` |
| `BOSS_WORKER_URL` | no | default `http://127.0.0.1:8795` |
| `BOSS_WORKER_TOOLS` | no | tools the worker really has; empty means it declines specs that need one |
| `BOSS_JOBS_PER_IP_DAY` | no | demo jobs one address may start; default `5` |
| `BOSS_JOBS_PER_DAY` | no | hard daily ceiling on the operator's wallet; default `60` |
| `BOSS_CONCURRENT_JOBS` | no | jobs running at once; default `2` |
| `BOSS_MAX_JOB_BUDGET` | no | USD cap per job, server-side; default `8` |
| `BOSS_SPECS_PER_IP_DAY` | no | spec writes per address; default `20` |
| `BOSS_LIMITS_FILE` | no | default `data/limits.json`; put it on the persistent disk |

`BOSS_EMBED_WORKER=1` runs the second firm as a child process on loopback, and `docs/DEPLOY.md` covers one-service hosting, the Render blueprint, and a post-deploy check.

## Project Structure

```text
frontend/     composer, live feed, deliverable card, market panel
src/firm/     stages, prompts, rules, judge, acceptance, worker firm
src/chain/    dependency-free NEAR client, treasury adapter, market adapter
src/ai/       model chain (NEAR AI → Groq → rules)
src/server/   HTTP API, SSE stream, market routes, public limits
contracts/    boss_treasury and boss_market (Rust)
scripts/      testnet deploys, market demo, worker daemon, wallet proof, sweep
tests/        node --test suites
docs/         deploy guide, trust model, screenshots
Dockerfile    one image for both roles
render.yaml   one-service blueprint with a persistent disk
```

## License

MIT — see [LICENSE](LICENSE).
