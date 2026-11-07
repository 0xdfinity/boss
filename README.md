# B.O.S.S.

A firm run by software: it takes one brief, hires agents to do the work, verifies each result, and pays only what passes.

*The first AI business that hires AIs, pays any chain, and can't steal the treasury.*

## Problem

- A business that wants to hire outside agents has no shared way to check the work before paying.
- Agent payments are usually a promise inside a prompt, so one bad output can drain the account.
- Every new agent integration means another custom payout path and another place to leak funds.

## Solution

BOSS turns a brief into a four-stage job — research, draft, critique, revise — and treats each stage as a separately hired agent. A stage is paid only when its deliverable passes verification.

1. **The model proposes, the contract decides.** The Rust treasury contract on NEAR enforces a `$2.00` per-payment cap and a `$20.00` daily budget. The server can ask for money; it cannot grant it.
2. **Verify first, pay second.** Deterministic rules check word bounds, the requested list count, the required pick, refusals, and whether the revision actually changed the draft. Drafts and revisions then face a model rubric that scores them against the brief.
3. **Outside agents are first-class.** Any agent can register a capability, a price, and a URL. If it wins the job, the contract sends it real NEAR. In-house agents are salaried and audited on the same ledger.
4. **Another firm can hire this one, and neither holds the other's money.** `boss_market` escrows the client's deposit against a spec hash. A worker firm with its own account and key delivers, publishes the result hash, and gets paid only after the client fetches the bytes, checks the hash, and judges the work. A refusal refunds the escrow. Two firms, one contract, no trust between them.

Status: both contracts are live on NEAR testnet. Cross-chain payout is a labelled dry quote, not a settled transfer; the tagline is the direction, not a claim about today.

Verification is honest: rules plus a model rubric today, with staked agents and challenge windows as the next step. No zk proofs, no TEE claims for work that never ran in one.

## Demo

![BOSS running a job on NEAR testnet](docs/boss-ui.png)

```text
npm run server        →  http://127.0.0.1:8787
brief  "Write 5 taglines for a coffee subscription, then pick the strongest"
result 4 agents paid · $2.40 · client verdict 78/100
```

This run settled four payments on NEAR testnet:
[research](https://testnet.nearblocks.io/txns/5etMvLV6SVkC7PyUTViEZrJWBLGS8FsDmthtztp2WHrv) ·
[draft](https://testnet.nearblocks.io/txns/q1y9Ry9szm2pw3SZ72YA6v5Effu8KdSb4SwaRvF367X) ·
[critique](https://testnet.nearblocks.io/txns/4wwwhNGGhSs25rLEfNWEwNyn6biNdgh4GMu7o55HVB6T) ·
[revise](https://testnet.nearblocks.io/txns/GXFE2JMQtNTpdw4Jm4eWzL7e1umcRAH5CTJYUmgwiWAY)

## Two firms, one escrow

The market is the part that makes this a protocol rather than a single app. The client is `boss-firm-506331.testnet`; the worker is `boss-worker-533815.testnet`, a separate top-level account with its own key. The contract is [`market.boss-firm-506331.testnet`](https://testnet.nearblocks.io/address/market.boss-firm-506331.testnet).

```text
npm run demo
```

That script starts both firms and runs two real jobs:

| Job | What happened | Settlement |
|---|---|---|
| A — five taglines | The worker delivered; the client fetched the bytes, matched the hash, judged 88/100 | [released 0.05 NEAR](https://testnet.nearblocks.io/txns/CRPK2PB3WS8tAC1pad8GxNxKYP7Gygep2Xc9ntjh7FN1) |
| B — requires a live source URL | The worker has no browser, said so in writing instead of inventing a source; the client's rules caught the refusal | [refunded 0.05 NEAR](https://testnet.nearblocks.io/txns/BQ1f8e6vccPrbv29dqvecJzTuYqwdKmvZQuQZzLmzxyR) |

The second job is the point. A payment demo shows money moving; this one shows money **not** moving because a claim did not survive the check.

![The BOSS market panel: job A released, job B refunded](docs/boss-market.png)

*The market panel after a run started from the browser. The scripted demo produces the same two outcomes.*

The open transactions are on chain too:
[job A opened](https://testnet.nearblocks.io/txns/ppSB8cz5tzbvz8ax5ySFkrLzCTY3LuVFxaqBdhMg5Ap) ·
[job B opened](https://testnet.nearblocks.io/txns/H2WjfPQoMbuNju9TDS7J8TCdFnVxWXtwAobG8J5cxBGs).

What the contract enforces today:

- a client cannot deliver its own job
- a submitted job cannot be settled twice
- only the client (or the optional `arbiter`) can release
- anyone can refund after the deadline, so a silent client cannot strand escrow
- a submitted-then-refunded job counts as a failure against the worker's reputation

The `arbiter` slot exists in state from day one. There is no arbiter panel yet: a panel is real design work, and a timeout is the honest version today.

## The client is a wallet

`npm run wallet:check` creates a throwaway testnet account with the two keys a
real visitor ends up with — a full-access key standing in for the wallet, and a
function-call key scoped to the market — then runs the whole client side with
the module the browser loads:

| Step | Transaction |
|---|---|
| account created with both keys | [CHdYrYSN…](https://testnet.nearblocks.io/txns/CHdYrYSNNhznDDVeBy8X75eeGhHfmWRDkmTrzDByKSpa) |
| `open_job`, 0.05 NEAR escrow, wallet key | [J7P8sQpV…](https://testnet.nearblocks.io/txns/J7P8sQpV7u8HUrthKUX33n64GYoFbUfo8D8tUKrUWETG) |
| `release` after an 88/100 verdict, scoped key | [FyqEy8C7…](https://testnet.nearblocks.io/txns/FyqEy8C7TBybAHQo6PUyzLfoxCqTdkDWf8oodCHdEVAU) |

The script also asserts the chain rule the UI is built around: the scoped key is
refused when the call carries a deposit. The popup itself (`/login`, `/sign`)
is a browser flow a script cannot drive; what is proven is that the
transactions the page hands it are accepted.

## Host it

The repo ships a `Dockerfile` and a Render blueprint. One container runs both
firms: the second firm is a child process with its own account and key, listening
on loopback, and only `/result/<id>` is proxied to the public origin — the client
fetches the deliverable and checks its hash before releasing escrow. Steps,
environment, and a post-deploy checklist are in [`docs/DEPLOY.md`](docs/DEPLOY.md).

A demo job pays the worker 0.05 NEAR out of the client account. `npm run sweep`
prints the surplus held by the worker and, with `--yes`, moves it back to the
client while keeping a 1 NEAR reserve, so a busy day does not leave the treasury
dry.

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Web UI | HTML, CSS, Canvas 2D, server-sent events | One composer, live job feed, deliverable card |
| Server | Node.js, zero runtime dependencies | Mission API, agent registry, SSE stream |
| Agents | JS modules and external HTTP agents | Plan, write, critique, revise |
| Verification | Deterministic rules, then model rubric | Decide whether a stage gets paid |
| Models | NEAR AI Cloud, Groq, rule-only fallback | Prose and verdicts |
| Treasury | Rust contract, `near-sdk` 5 | Caps, payouts, audit log on NEAR |
| Market | Rust contract, `near-sdk` 5 | Cross-firm escrow, deadlines, reputation |

The router tries NEAR AI Cloud first, then Groq. **The live demo runs Groq**: `NEAR_AI_MODEL` is empty. Set it plus a NEAR AI Cloud key and the same router calls NEAR AI first — `GET /health` lists the providers in order, so the claim is checkable rather than asserted.

## Architecture

```text
browser → /api/mission/stream (SSE)
  → planner fixes the stages and prices
  → per stage: hire agent → execute → rules → model rubric
  → treasury.authorize → boss_treasury.pay() on NEAR → receipt in the feed
```

The server signs one transaction at a time per access key, so concurrent stage payments cannot collide on a nonce.

The cross-firm path is separate and deliberately small:

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

If the hash does not match, or the result cannot be fetched, the client refunds. It never pays on the worker's word.

## Key Features

- One brief becomes a priced, payable job with a fixed stage order
- Payment is gated on a passing verdict; a failed stage pays nothing and the job stops or retries
- Outside agents undercut in-house prices and receive real NEAR when they win
- Spend caps live in the contract, not in the prompt
- Every hire, verdict, and payment appears in the live feed with a transaction hash
- A second firm can be hired through `boss_market`; the client releases or refunds after checking the result hash
- Same pipeline runs headless: `node src/index.js --brief "…"`

## Quick Start

**Prerequisites:** Node 20 or newer. Rust with the `wasm32-unknown-unknown` target only if you redeploy the contracts.

```console
# from an existing checkout of this repository
npm install         # zero runtime dependencies
npm test            # 50 tests: policy caps, plan rules, firm flow, acceptance, RPC failover, public limits, model status
npm run server      # http://127.0.0.1:8787
```

Open the page, type a brief, press send. With no model key the firm refuses the
first stage and pays nothing — it does not guess at the work — and the feed says
which key to set.

Two commands check a key without printing it. `npm run models` lists what the key
can reach and flags a model id that is not on the list; `npm run model:check`
runs one real JSON completion through the router and reports which provider
answered, so a key that lists a model but is refused by it cannot pass as
healthy.

### Two ways in

Model keys are server-side infrastructure. Nobody who visits the site is asked
for one, and nobody has to copy-paste a key to see it work.

| Path | What the visitor does | Who pays |
|---|---|---|
| **demo job** | presses one button, no wallet | the operator, metered at 5 jobs per address per day |
| **run as your firm** | connects a testnet wallet, signs the escrow | the visitor, with their own testnet NEAR |

The second path is the point: the wallet is the client. `open_job` carries a
deposit, and NEAR forbids deposits on function-call keys, so the wallet itself
signs that one transaction. The site holds a function-call key scoped to
`open_job`, `release`, and `refund` and uses it only for the zero-deposit
settlement. The server sees signed transactions, never a secret.

**Chain setup (only needed for real payments).** Without a wallet the treasury runs in `mirror` mode: the caps and verdicts are real, no transaction is sent. For settlement on testnet, put a funded testnet account and its full-access key in `.env`:

```console
NEAR_ACCOUNT=you.testnet
NEAR_PRIVATE_KEY=ed25519:...
```

Any testnet account works — a wallet key imports directly, and NEAR's testnet faucet funds a new one. The two deploy scripts below create the contract accounts from that key and write the ids back. The key stays server-side and is gitignored.

**The market demo (two firms, real escrow):**

```console
npm run demo
```

This starts the server and the worker if they are not already up, opens two jobs, and prints the settlement transactions. It needs the market deployment described below. To drive the same flow from the UI, run `npm start` and `npm run worker` in separate terminals, then open the page and press **market**.

**Headless run:**

```console
npm run dryrun -- "Write 5 taglines for a coffee subscription, then pick the strongest"
```

**Testnet treasury:**

```console
cargo build --release --target wasm32-unknown-unknown --manifest-path contracts/boss_treasury/Cargo.toml
npm run deploy:testnet
```

**Testnet market + second firm:**

```console
cargo build --release --target wasm32-unknown-unknown --manifest-path contracts/boss_market/Cargo.toml
npm run deploy:market
```

`deploy:market` creates `market.<your-account>.testnet`, deploys and initialises the contract, creates a second top-level account with its own key, funds it for gas, and writes the ids back to `.env`. It never prints a key. `deploy:testnet` does the same for the treasury.

**Environment variables** (copy `.env.example` to `.env`; `.env` is gitignored):

| Variable | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | for model verdicts | prose and rubric calls |
| `GROQ_MODEL` | no | default `openai/gpt-oss-120b` |
| `GROQ_BASE_URL` | no | default `https://api.groq.com/openai/v1` |
| `NEAR_AI_API_KEY` | optional | primary model provider |
| `NEAR_AI_MODEL` | optional | leave empty to skip NEAR AI |
| `NEAR_AI_BASE_URL` | no | default `https://cloud-api.near.ai`; the website `cloud.near.ai` is not the API |
| `NEAR_ACCOUNT` | for on-chain pay | treasury and market signer account |
| `NEAR_PRIVATE_KEY` | for on-chain pay | signer key, server-side only |
| `BOSS_TREASURY_CONTRACT_ID` | for on-chain pay | deployed treasury contract |
| `BOSS_MARKET_CONTRACT_ID` | for the market | deployed escrow contract |
| `BOSS_WORKER_ACCOUNT` | for the market | second firm's account |
| `BOSS_WORKER_KEY` | for the market | second firm's key, server-side only |
| `BOSS_WORKER_PORT` | no | default `8795` |
| `BOSS_WORKER_URL` | no | default `http://127.0.0.1:8795` |
| `BOSS_WORKER_TOOLS` | no | tools the worker really has; empty means it declines specs that need one |
| `NEAR_RPC_URL` | no | default `https://test.rpc.fastnear.com`; near.org's public endpoint is retiring |
| `NEAR_NETWORK` | no | `testnet` or `mainnet` |
| `NEAR_USD_RATE` | no | USD per NEAR for transfers; default `10` |
| `SITE_URL` | no | default `http://127.0.0.1:8787`; where specs are published. Render's `RENDER_EXTERNAL_URL` is used when this is unset |
| `PORT` | no | default `8787` |
| `BOSS_BIND` | no | default `127.0.0.1`; set `0.0.0.0` in a container |
| `BOSS_TRUST_PROXY` | no | `1` behind a proxy, so per-IP limits read `x-forwarded-for` |
| `BOSS_JOBS_PER_IP_DAY` | no | demo jobs one address may start; default `5` |
| `BOSS_JOBS_PER_DAY` | no | hard daily ceiling on the operator's wallet; default `60` |
| `BOSS_CONCURRENT_JOBS` | no | jobs running at once; default `2` |
| `BOSS_MAX_JOB_BUDGET` | no | USD cap per job, server-side; default `8` |
| `BOSS_SPECS_PER_IP_DAY` | no | spec writes per address; default `20` |
| `BOSS_LIMITS_FILE` | no | `data/limits.json`; put it on the persistent disk |

## Project Structure

```text
frontend/     composer, live feed, deliverable card, market panel
src/firm/     stages, prompts, rules, judge, acceptance, worker firm
src/chain/    dependency-free NEAR client, treasury adapter, market adapter
src/ai/       model chain (NEAR AI → Groq → none)
src/server/   HTTP API, SSE stream, market routes
contracts/    boss_treasury and boss_market (Rust)
scripts/      testnet deploys, market demo, worker daemon, dry run, wallet proof
tests/        node --test suites
docs/         deploy guide, agent-economy notes, screenshots
Dockerfile    one image for both roles
render.yaml   two-service blueprint (firm + worker)
```

## License

MIT — see [LICENSE](LICENSE).
