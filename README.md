# Fly Brain Deploys on Railway 🪰🚂

A **real spiking simulation of the full fruit-fly brain** — all 139,255
neurons and ~2.7M synaptic connections of the FlyWire FAFB v783 connectome —
whose **emergent behavior builds a real multi-service app on Railway** via
the public GraphQL API.

The fly service is deployed **inside the very project it builds**: it spawns
postgres, redis, web and worker as sibling services next to itself, using a
project-scoped token. Open the project on Railway's dashboard and you watch
the fly's neighbors pop into existence around it — the dashboard *is* the
proof.

Everyone watches **one shared fly**. The server runs the single authoritative
simulation (LIF sim in a `worker_thread` + behavior loop) and broadcasts state
over SSE; browsers are pure renderers. Viewers need no Railway account.

## How it works (the honest architecture)

Like every viral connectome demo (Beat Saber, Doom, MK64…), there's a scaffold
and a brain, and the split is explicit:

- A **mission state machine** defines *what* step is next
  (Postgres → Redis → Web → Worker → wire variables).
- The **brain decides when and how**: each pending step manifests as *food*
  at that service's node on a Railway-style canvas. The fly's real hunger
  drive routes spikes `OLF_ORN_FOOD / GUS_GRN_SWEET → connectome →
  SEZ_FEED / MN_PROBOSCIS → feed behavior`. The fly must smell the food,
  walk to it, and eat it — all emergent from the spiking sim.
- When the food is fully eaten, the **real GraphQL mutation fires**
  (`serviceCreate`, `variableUpsert`, `serviceInstanceDeployV2`, …).
- Deployment failures inject a one-shot **NOCI nociception stimulus** — the
  fly startles away from the failed node (emergent), then the step re-arms.
- When all four services are green: **ALL GREEN**, confetti, and a live URL.
- **SWAT** deletes only the services the fly created — never the fly's own
  service — so the fly survives its own teardown and can run again.

The only knob the mission touches inside the brain: while a step is pending
it clamps `hunger ≥ 0.75` (the existing feed-entry path is
`hunger > 0.7 && foodNearby`), and mission food has a long-range odor plume so
the fly can smell a node from across the board. Everything between the odor
and the proboscis is the connectome's problem.

## Run it locally (no Railway account needed)

```sh
DRY_RUN=1 node server/index.js
# open http://localhost:8080 — click admin → Start mission (twice to confirm)
```

`DRY_RUN=1` logs every mutation instead of calling Railway and fakes
deployment SUCCESS ~10s after each deploy. The brain, the fly, and the whole
mission flow are identical.

Test the failure path: `DRY_RUN=1 DRY_RUN_FAIL=redis:1 node server/index.js`
makes the redis deploy fail once → watch the NOCI startle and the retry.

## Run it for real

1. **Create a Railway project** (empty is fine) and deploy this repo as a
   service in it — Railway picks up the `Dockerfile` + `railway.json`.
2. In the project: **Settings → Tokens → create a project token** for the
   `production` environment. Project tokens are scoped to exactly this
   project — the fly cannot touch anything else on your account.
3. On the fly service, set:
   - `RAILWAY_TOKEN` = the project token
   - `ADMIN_PASSWORD` = something secret (gates start/SWAT on the public URL)
4. (Recommended) **Verify the schema first** — Railway's API drifts:
   ```sh
   RAILWAY_TOKEN=<project token> node scripts/schema-smoke-test.js          # introspection only
   RAILWAY_TOKEN=<project token> node scripts/schema-smoke-test.js --live   # + throwaway service (created & deleted)
   ```
5. Open the fly service's public URL, enter the admin password, hit
   **Start mission** (twice). Watch the project's dashboard fill up.
6. Optionally toggle the project to **public** in its settings so spectators
   can verify the services are real on Railway's own dashboard.
7. Done? **SWAT** deletes the spawned services (the fly stays).

⚠️ **This creates real services on your Railway account.** The four services
(postgres:16-alpine, redis:7-alpine, nginx:alpine, alpine:3) are tiny
but not free forever — tear down when done (`SWAT`, or set
`TEARDOWN_AFTER_MIN`). A full run makes <60 API requests (fits the free
tier's 100/h; Hobby recommended). `RAILWAY_PROJECT_ID` /
`RAILWAY_ENVIRONMENT_ID` are auto-injected by Railway; locally the project
token itself tells the fly its scope.

Why `ADMIN_PASSWORD` even with a scoped token: the spectator URL is public,
and without the gate any visitor could POST `/api/mission/start` and spawn
billable services in your project (or SWAT your demo mid-run). The token
never reaches browsers; the password is just the trigger guard.

### Environment variables

| var | meaning |
|---|---|
| `RAILWAY_TOKEN` | **project token** (server-side only, never sent to browsers) |
| `RAILWAY_TOKEN_TYPE` | `project` (default) or `account` — controls the auth header |
| `ADMIN_PASSWORD` | gates all POSTs (`x-fly-admin` header). **Required for public deploys** |
| `PORT` | listen port (default 8080) |
| `DRY_RUN=1` | log mutations, fake SUCCESS — full demo without a token |
| `DRY_RUN_FAIL` | e.g. `redis:1` — force n failures for a service (dry-run) |
| `TEARDOWN_AFTER_MIN` | auto-SWAT n minutes after ALL GREEN |
| `AUTO_LOOP=1` | exhibit mode: start on boot, then loop mission → ALL GREEN → SWAT → mission forever; HUD shows runs / last / best times |
| `LOOP_LINGER_MIN` | auto-loop: minutes to admire the green board before SWAT (default 3) |
| `LOOP_REST_MIN` | auto-loop: minutes of rest between runs (default 2) |
| `STATS_FILE` | where run stats persist (default `/data/fly-stats.json` — mount a Railway volume at `/data` to keep best times across redeploys; in-memory otherwise) |
| `RUNS_FILE` | append-only JSONL run history, one `{t, ms, retries, best}` record per completed run (default `/data/fly-runs.jsonl`, needs the same volume) |
| `WEB_IMAGE` | custom image for the web step (see below); default `nginx:alpine` |
| `WEB_PORT` | domain target port for the web service (default 3000 when `WEB_IMAGE` set, else 80) |

The worker is an `alpine:3` container that actually uses the wiring: after
the wire-vars step it runs a real `SELECT 1` against Postgres and a redis-cli
`PING` every 30s — watch its logs on the dashboard.

### Custom web page ("this site was deployed by a fly")

`web/` contains a tiny Next.js app whose index proudly explains it was
deployed by a fly, with a live backlink to the spectator app. Build and push
it once, then point the mission at it:

```sh
cd web
docker build -t ghcr.io/<you>/fly-web:latest .
docker push ghcr.io/<you>/fly-web:latest   # make the package public
```

Set `WEB_IMAGE=ghcr.io/<you>/fly-web:latest` on the fly service. The mission
then wires `PORT`/`FLY_APP_URL` onto the web service automatically and the
domain targets the Next.js port. Left unset, the web step deploys plain
`nginx:alpine` (instant green, default page).

⚠️ `AUTO_LOOP` means continuous real spend and steady API traffic (~3-4
runs/hour ≈ 150-250 requests/h — above the free tier's 100/h; use Hobby).
Run times reset when the fly service redeploys (stats are in-memory).

## Deploy as a template

Make it one-click: publish this repo, then in Railway create a **template**
containing a single service built from the repo, with `RAILWAY_TOKEN` and
`ADMIN_PASSWORD` as required inputs. Each deployer gets their own project,
their own fly, and a token scoped to just that project. (The deployer creates
the project token after the first deploy and pastes it in — tokens are minted
per-project, so the template can only prompt for it, not pre-fill it.)

## Architecture

```
server/
  index.js          zero-dep node:http — static + REST + SSE fan-out
  brain-host.js     worker_thread host for the LIF sim (ports brain-worker-bridge)
  sim-worker-shim.js maps self.onmessage/postMessage ↔ parentPort
  behavior.js       authoritative fly: behavior FSM + movement + food (ports main.js)
  mission.js        mission state machine; food ↔ GraphQL mutation glue
  railway-client.js GraphQL ops → backboard.railway.com/graphql/v2
  poller.js         deployment status polling w/ backoff
vendor-sim/         flybrain sim vendored verbatim (sim-worker.js unmodified)
data/               connectome.bin.gz (12.4MB) + neuron_meta.json
js/, css/, index.html   spectator client (SSE renderers only — no sim in browser)
```

SSE events: `fly` (~15Hz position/behavior), `spikes` (10Hz per-group fired
counts — the browser never downloads the 12.4MB connectome), `mission`
(state deltas + log), `viewers`. One Node process handles hundreds of
spectators; viewer count adds zero Railway API calls.

## Credits & license

MIT (see `LICENSE`). Simulation adapted from
[snedea/flybrain](https://github.com/snedea/flybrain). Connectome data from
[FlyWire](https://flywire.ai) (FAFB v783, **CC-BY-NC 4.0**) — see `NOTICE.md`
for full attribution. Not affiliated with Railway.
