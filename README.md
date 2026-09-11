# Fly Brain Deploys on Railway 🪰🚂

A **real spiking simulation of the full fruit-fly brain** — all 139,255
neurons and ~2.7M synaptic connections of the FlyWire FAFB v783 connectome —
whose **emergent behavior deploys a real multi-service app on Railway** via
the public GraphQL API. And the whole thing runs *on* Railway: a
fly-on-Railway that deploys-to-Railway.

Everyone watches **one shared fly**. The server runs the single authoritative
simulation (LIF sim in a `worker_thread` + behavior loop) and broadcasts state
over SSE; browsers are pure renderers. Viewers need no Railway account, and
the project the fly creates is made **public read-only** on Railway so
spectators can verify on Railway's own dashboard that the services are real.

## How it works (the honest architecture)

Like every viral connectome demo (Beat Saber, Doom, MK64…), there's a scaffold
and a brain, and the split is explicit:

- A **mission state machine** defines *what* step is next
  (create project → Postgres → Redis → Web → Worker → wire variables).
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

1. Create a Railway **account or workspace token**
   (Account settings → Tokens). Project tokens can't `projectCreate`.
2. **Verify the schema first** (Railway's API drifts):
   ```sh
   RAILWAY_TOKEN=... node scripts/schema-smoke-test.js          # introspection only
   RAILWAY_TOKEN=... node scripts/schema-smoke-test.js --live   # + throwaway project (created & deleted)
   ```
3. Start the server:
   ```sh
   RAILWAY_TOKEN=... ADMIN_PASSWORD=change-me node server/index.js
   ```
4. Open the app, enter the admin password, hit **Start mission** (twice).
5. When you're done: **SWAT** deletes the created project.

⚠️ **This creates real services on your Railway account.** The four services
(postgres:16-alpine, redis:7-alpine, nginx:alpine, busybox:stable) are tiny
but not free forever — tear down when done (`SWAT`, or set
`TEARDOWN_AFTER_MIN`). A full run makes <60 API requests (fits the free tier's
100/h; Hobby recommended).

### Environment variables

| var | meaning |
|---|---|
| `RAILWAY_TOKEN` | account/workspace token (server-side only, never sent to browsers) |
| `RAILWAY_TEAM_ID` | optional — create the project in a team/workspace |
| `ADMIN_PASSWORD` | gates all POSTs (`x-fly-admin` header). **Required for public deploys** — without it anyone can spend your money |
| `PORT` | listen port (default 8080) |
| `DRY_RUN=1` | log mutations, fake SUCCESS — full demo without a token |
| `DRY_RUN_FAIL` | e.g. `redis:1` — force n failures for a service (dry-run) |
| `TEARDOWN_AFTER_MIN` | auto-SWAT n minutes after ALL GREEN |
| `MISSION_PROJECT_NAME` | created project's name (default `fly-deployed-app`) |

## Deploy the demo itself on Railway

The repo ships a `Dockerfile` + `railway.json` (healthcheck `/api/health`,
zero npm dependencies). Create a Railway service from this repo, set
`RAILWAY_TOKEN` + `ADMIN_PASSWORD` on it, deploy, then open the public URL
from any device and spectate. Optionally make the *host* project public too.

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
