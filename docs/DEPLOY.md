# Deploying BOSS

BOSS is one Node process with no database and no build step. Anything that runs
a container or a Node 20+ process with one persistent directory can host it.

Two hosts are needed for the full market flow:

| Role | What it does | Public? |
|---|---|---|
| **firm** | the site, the API, the client that judges and releases escrow | yes |
| **worker** | the second firm; delivers work and serves `/result/:id` | **yes** |

The worker is public on purpose: the client fetches the deliverable from a URL
and checks its SHA-256 against the hash the worker put on chain before releasing
escrow. A private worker cannot be verified.

## 1. Prepare the account

You need a funded NEAR testnet account and the market contract. On a dev machine:

```console
npm run deploy:testnet     # treasury contract on <you>.testnet
npm run deploy:market      # market contract + second firm with its own key
```

Both write ids into `.env` and never print a key. Keep roughly **3 NEAR liquid**
on the client account for a full day of demo jobs (60 × 0.05 NEAR escrow). Locked
storage stake does not count — check `available = amount - locked` if a create
fails with `LackBalanceForState`.

## 2. Render (blueprint included)

1. Push the repo to GitHub, then **New → Blueprint** and select it.
2. `render.yaml` creates two web services and a 1 GB disk on `boss`.
3. Fill the `sync: false` secrets from `.env` in each service. Do not paste them
   into the blueprint.
4. Wait for both services. Set their real URLs back into the environment:
   - firm: `SITE_URL=https://<firm>.onrender.com`,
     `BOSS_WORKER_URL=https://<worker>.onrender.com`
   - worker: `BOSS_WORKER_URL=https://<worker>.onrender.com`
5. Redeploy the firm so `SITE_URL` is picked up (spec links use it).

The disk is what keeps the daily demo counters across deploys. Without it the
counters reset, which only lowers what is allowed.

Render's free plan has no disks; use Starter or another host.

## 3. Railway, Fly, or a VPS

Any of these work with the same image:

```console
docker build -t boss .
docker run -p 8787:8787 --env-file .env -e BOSS_BIND=0.0.0.0 -v boss-data:/app/data boss
docker run -p 8795:8795 --env-file .env -e BOSS_BIND=0.0.0.0 -e BOSS_WORKER_PORT=8795 boss node scripts/firm_worker.mjs
```

On a VPS put Caddy or nginx in front for TLS (MyNearWallet will only talk to
an `https` origin). The wallet popup also requires a secure context, so plain
`http://` on a public IP will not connect.

## 4. Quick tunnel (no PaaS)

For a short-lived demo, the machine running the server can be exposed with a
Cloudflare tunnel:

```console
cloudflared tunnel --url http://127.0.0.1:8787
```

Set `SITE_URL` to the tunnel URL and `BOSS_TRUST_PROXY=1` only if the tunnel
rewrites `x-forwarded-for`. The URL changes when the tunnel restarts, so spec
links from an old run stop resolving.

## 5. Environment

| Variable | Default | Notes |
|---|---|---|
| `BOSS_BIND` | `127.0.0.1` | must be `0.0.0.0` in a container |
| `BOSS_TRUST_PROXY` | off | `1` behind a proxy, so per-IP limits read `x-forwarded-for` |
| `SITE_URL` | `http://127.0.0.1:8787` | public URL of the firm; spec links use it |
| `BOSS_JOBS_PER_IP_DAY` | `5` | demo jobs one address may start |
| `BOSS_JOBS_PER_DAY` | `60` | hard ceiling on the operator's wallet |
| `BOSS_CONCURRENT_JOBS` | `2` | jobs running at once |
| `BOSS_MAX_JOB_BUDGET` | `8` | USD cap per job, enforced server-side |
| `BOSS_SPECS_PER_IP_DAY` | `20` | spec writes, separate from jobs |
| `BOSS_LIMITS_FILE` | `data/limits.json` | put it on the persistent disk |
| `BOSS_WORKER_URL` | `http://127.0.0.1:8795` | public URL of the worker |
| `BOSS_WORKER_PORT` | `$PORT` or `8795` | the worker honours `PORT`, which PaaS sets |
| `NEAR_AI_API_KEY` / `NEAR_AI_MODEL` | — | primary model provider when both are set |
| `GROQ_API_KEY` | — | fallback provider; the only one needed to run |

Model keys are infrastructure: visitors never supply one. Judges either press
the metered demo button or connect a wallet and escrow their own testnet NEAR.

## 6. Verify a deployment

```console
curl -s https://<firm>/health
```

Expect `"ok":true`, `"live":{"models":["near-ai","groq"]}`, the treasury and
market ids, and a chain mode of `near`. Then, in the browser:

1. Press **market** → **run a demo job (no wallet)**. The feed must show
   `open_job`, a delivery, a verdict, and a release or refund transaction.
2. Connect a testnet wallet → approve the scoped key → **run as your firm**.
   MyNearWallet should show the escrow once and the settlement once.
3. `curl -s https://<firm>/api/limits` should count the job you just ran.

If the demo button returns 429, the day's allowance is spent; `/api/limits`
says which cap. `data/limits.json` can be reset by deleting it.

## 7. What is deliberately not here

- No mainnet. The chain client and the UI are testnet-scoped, and NEAR Intents
  has no testnet, so the cross-chain number is a labelled dry quote.
- No database. Job state lives on chain; the server keeps only specs, agent
  config, and counters, all in `data/`.
- No multi-replica setup. Two processes share one disk; a second replica would
  need the limit counters and spec store moved out first.
