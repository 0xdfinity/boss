# Deploying BOSS

BOSS is one Node process with no database and no build step. Anything that runs
a container or a Node 20+ process with one persistent directory can host it.

The default shape is **one service, one URL**:

```text
https://boss.example.com              the site, the API, the client
https://boss.example.com/result/<id>  the second firm's deliveries
```

The second firm still has its own account and key; it runs as a child process on
loopback and signs its own transactions. Only its `/result/<id>` path is
proxied, because the client fetches the deliverable from a public URL and checks
its SHA-256 before releasing escrow.

## 1. Prepare the accounts

On a dev machine:

```console
npm run deploy:testnet     # treasury contract on <you>.testnet
npm run deploy:market      # market contract + second firm with its own key
```

Both write ids into `.env` and never print a key. Keep roughly **3 NEAR liquid**
on the client account for a full day of demo jobs (60 × 0.05 NEAR escrow). Locked
storage stake does not count — if a create fails with `LackBalanceForState`,
compare `amount` and `locked`, not just the headline balance.

Released jobs pay the second firm, so its balance grows while the client's
shrinks. `npm run sweep` shows what it is holding and, with `--yes`, transfers
the surplus back and leaves a 1 NEAR reserve.

## 2. Render (blueprint included)

1. Push the repo to GitHub, then **New → Blueprint** and select it.
2. `render.yaml` creates one web service with a 1 GB disk.
3. Fill the `sync: false` secrets from `.env` in the dashboard: `NEAR_ACCOUNT`,
   `NEAR_PRIVATE_KEY`, `BOSS_TREASURY_CONTRACT_ID`, `BOSS_MARKET_CONTRACT_ID`,
   `BOSS_WORKER_ACCOUNT`, `BOSS_WORKER_KEY`, `GROQ_API_KEY`, and
   `NEAR_AI_API_KEY` if you have one. Do not paste them into the blueprint.
4. Open `https://<name>.onrender.com/health`. The blueprint does not ask for
   `SITE_URL`: Render sets `RENDER_EXTERNAL_URL`, and the app uses it for spec
   links and the worker's `result_url`. Set `SITE_URL` yourself only for a
   custom domain, then redeploy.
5. Run one demo job and confirm its `result_url` is on the public host.

The disk is what keeps the daily demo counters across deploys. Without it the
counters reset, which only lowers what is allowed. Render's free plan has no
disks; use Starter or another host.

### Split into two services (optional)

If you want the second firm on its own host, deploy the same image twice:

- firm: `BOSS_EMBED_WORKER=0`, `BOSS_WORKER_URL=https://<worker>`.
- worker: start command `node scripts/firm_worker.mjs`, `BOSS_WORKER_PORT=$PORT`
  (the worker honours `PORT`), `BOSS_WORKER_URL=https://<worker>`, and no disk.

That costs a second always-on instance. A free worker spins down after 15 idle
minutes, stops polling for jobs, and the demo stops finding a worker.

## 3. Railway, Fly, or a VPS

The same image works anywhere:

```console
docker build -t boss .
docker run -d -p 8787:8787 --env-file .env \
  -e BOSS_BIND=0.0.0.0 -e BOSS_EMBED_WORKER=1 \
  -e SITE_URL=https://boss.example.com \
  -v boss-data:/app/data boss
```

On a VPS put Caddy or nginx in front for TLS: MyNearWallet only talks to an
`https` origin, and the wallet popup needs a secure context. Plain `http://` on
a public IP will not connect.

## 4. Quick tunnel (no PaaS)

For a short-lived demo, expose the local server:

```console
cloudflared tunnel --url http://127.0.0.1:8787
```

Set `SITE_URL` to the tunnel URL and `BOSS_TRUST_PROXY=1`. The URL changes when
the tunnel restarts, and spec links from an old run stop resolving. This is a
demo aid, not a submission host.

## 5. Environment

| Variable | Default | Notes |
|---|---|---|
| `BOSS_BIND` | `127.0.0.1` | must be `0.0.0.0` in a container |
| `BOSS_TRUST_PROXY` | off | `1` behind a proxy, so per-IP limits read `x-forwarded-for` |
| `BOSS_EMBED_WORKER` | off | `1` runs the second firm in the same container |
| `SITE_URL` | `http://127.0.0.1:8787` | public URL; spec links and result URLs use it. On Render, `RENDER_EXTERNAL_URL` is used when this is unset |
| `BOSS_JOBS_PER_IP_DAY` | `5` | demo jobs one address may start |
| `BOSS_JOBS_PER_DAY` | `60` | hard ceiling on the operator's wallet |
| `BOSS_CONCURRENT_JOBS` | `2` | jobs running at once |
| `BOSS_MAX_JOB_BUDGET` | `8` | USD cap per job, enforced server-side |
| `BOSS_SPECS_PER_IP_DAY` | `20` | spec writes, separate from jobs |
| `BOSS_LIMITS_FILE` | `data/limits.json` | put it on the persistent disk |
| `BOSS_WORKER_PORT` | `8795` | loopback port of the embedded worker |
| `BOSS_WORKER_URL` | `SITE_URL` when embedded | public URL the worker advertises |
| `NEAR_AI_API_KEY` / `NEAR_AI_MODEL` | — | primary model provider when both are set |
| `GROQ_API_KEY` | — | fallback provider; the only one needed to run |

Model keys are infrastructure: visitors never supply one. Judges either press
the metered demo button or connect a wallet and escrow their own testnet NEAR.

## 6. Verify a deployment

```console
curl -s https://<host>/health
```

Expect `"ok":true`, `"live":{"models":[...]}`, the treasury and market ids, and
a chain mode of `near` (`mirror` means no key was picked up). `live.modelStatus`
is what each provider did on its last call: `ok: null` means not tried yet, and
a `false` carries the provider's own error, so a bad key cannot hide behind a
working fallback. Before deploying, `npm run model:check` proves one real
completion goes through. Then:

1. Press **market** → **run a demo job (no wallet)**. The feed must show
   `open_job`, a delivery, a verdict, and a release or refund transaction whose
   `result_url` points at the public host.
2. Connect a testnet wallet → approve the scoped key → **run as your firm**.
   MyNearWallet shows the escrow once (it signs `open_job`) and the settlement
   once (the scoped key signs `release`/`refund`).
3. `curl -s https://<host>/api/limits` counts the job you just ran.

If the demo button returns 429, the day's allowance is spent; `/api/limits`
says which cap. `data/limits.json` can be reset by deleting it and restarting.

## 7. What is deliberately not here

- No mainnet. The chain client and the UI are testnet-scoped, and NEAR Intents
  has no testnet, so the cross-chain number is a labelled dry quote.
- No database. Job state lives on chain; the server keeps only specs, agent
  config, and counters, all in `data/`.
- No multi-replica setup. One process owns one disk and one embedded worker; a
  second replica would need the counters and spec store moved out first.
