/* mission.js
 *
 * Mission state machine (in-project model). The fly service is deployed
 * INSIDE the Railway project it builds: the mission spawns postgres, redis,
 * web and worker as sibling services next to the fly itself, using a
 * project-scoped token. The project's own dashboard is the live proof.
 *
 * The mission defines WHAT step is next; the brain decides WHEN and HOW:
 * each pending step manifests as food at that service's node on the board.
 * When the fly's emergent feed behavior finishes eating the food, the step's
 * real Railway GraphQL mutations fire (in-process). Deploy failures trigger
 * the NOCI nociception pathway (emergent startle), then the step re-arms
 * after a cooldown.
 *
 * SWAT (teardown) deletes ONLY the services the fly created -- never the
 * fly's own service (RAILWAY_SERVICE_ID) -- so the fly survives its own swat
 * and the mission can run again.
 *
 * Mission: IDLE -> ARMED -> RUNNING -> ALL_GREEN -> TORN_DOWN (+ ABORTED)
 * Steps:   LOCKED -> AVAILABLE -> EXECUTING -> VERIFYING -> DONE | FAILED
 */
'use strict';

const crypto = require('node:crypto');

const HUNGER_FLOOR = 0.75;
const FAILURE_COOLDOWN_MS = 8000;
const MAX_RETRIES = 3;

const STEP_DEFS = [
	{
		id: 'postgres',
		title: 'Deploy Postgres',
		node: { x: 280, y: 300 },
		serviceName: 'postgres',
		image: 'postgres:16-alpine',
	},
	{
		id: 'redis',
		title: 'Deploy Redis',
		node: { x: 1320, y: 300 },
		serviceName: 'redis',
		image: 'redis:7-alpine',
	},
	{
		id: 'web',
		title: 'Deploy Web',
		node: { x: 280, y: 650 },
		serviceName: 'web',
		image: 'nginx:alpine',
	},
	{
		id: 'worker',
		title: 'Deploy Worker',
		node: { x: 1320, y: 650 },
		serviceName: 'worker',
		image: 'busybox:stable',
	},
	{
		id: 'wire-vars',
		title: 'Wire variables',
		node: { x: 800, y: 760 },
		serviceName: 'worker',
	},
];

function createMission(deps) {
	const behavior = deps.behavior;
	const client = deps.client;
	const poller = deps.poller;
	const emit = deps.emit || function () {};
	const logSink = deps.log || function () {};
	const teardownAfterMin = Number(deps.teardownAfterMin || process.env.TEARDOWN_AFTER_MIN || 0);
	// The fly's own service -- teardown must never touch it.
	const ownServiceId = deps.ownServiceId || process.env.RAILWAY_SERVICE_ID || null;

	const state = {
		mission: 'IDLE',
		projectId: null,
		environmentId: null,
		projectUrl: null,
		webDomain: null,
		serviceStatuses: {}, // serviceName -> deployment status
		startedAt: null,
		steps: STEP_DEFS.map(function (d) {
			return {
				id: d.id,
				title: d.title,
				node: d.node,
				state: 'LOCKED',
				retries: 0,
				serviceId: null,
				detail: '',
			};
		}),
		log: [], // {ts, line}
	};

	let pgPassword = null;
	let teardownTimer = null;
	let executing = false;

	function stepDef(id) {
		return STEP_DEFS.find(function (d) { return d.id === id; });
	}
	function step(id) {
		return state.steps.find(function (s) { return s.id === id; });
	}

	// Unique ids of services the mission created (wire-vars shares worker's)
	function spawnedServiceIds() {
		const ids = [];
		for (const st of state.steps) {
			if (st.serviceId && ids.indexOf(st.serviceId) === -1 && st.serviceId !== ownServiceId) {
				ids.push(st.serviceId);
			}
		}
		return ids;
	}

	function missionActive() {
		return state.mission === 'RUNNING' || state.mission === 'ARMED';
	}

	function log(line) {
		const entry = { ts: Date.now(), line: line };
		state.log.push(entry);
		if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
		logSink(line);
		emit({ kind: 'log', ts: entry.ts, line: line });
	}

	function setMissionState(s) {
		state.mission = s;
		emit({ kind: 'mission-state', state: s });
	}

	function setStepState(st, s, detail) {
		st.state = s;
		if (detail !== undefined) st.detail = detail;
		emit({ kind: 'step', stepId: st.id, state: s, retries: st.retries, detail: st.detail });
	}

	function setServiceStatus(name, status) {
		if (state.serviceStatuses[name] === status) return;
		state.serviceStatuses[name] = status;
		emit({ kind: 'services', statuses: state.serviceStatuses });
	}

	function onStatuses(services) {
		for (const svc of services) {
			// Only the services the mission owns; ignores the fly's own service
			// and anything else living in the project.
			if (['postgres', 'redis', 'web', 'worker'].indexOf(svc.name) !== -1) {
				setServiceStatus(svc.name, svc.status);
			}
		}
	}

	/* ---- step availability: food appears at the node ---- */

	function makeAvailable(st) {
		setStepState(st, 'AVAILABLE');
		behavior.spawnFood(st.node.x, st.node.y, st.id);
		behavior.setHungerFloor(HUNGER_FLOOR);
		log('🍩 Food odor drifts from the "' + st.title + '" node -- the fly grows hungry...');
	}

	/* ---- the hook: fly finished eating -> real mutation ---- */

	async function onFoodConsumed(stepId) {
		const st = step(stepId);
		if (!st || st.state !== 'AVAILABLE' || executing) return;
		executing = true;
		behavior.setHungerFloor(0);
		setStepState(st, 'EXECUTING');
		log('🪰 The fly devoured the food at "' + st.title + '" -- executing Railway mutation');
		try {
			await executeStep(st);
		} catch (err) {
			log('❌ ' + st.title + ' failed: ' + err.message);
			await stepFailed(st);
		} finally {
			executing = false;
		}
	}

	async function executeStep(st) {
		switch (st.id) {
		case 'postgres': {
			if (!st.serviceId) {
				const r = await client.serviceCreate(state.projectId, 'postgres', stepDef(st.id).image);
				st.serviceId = r.serviceId;
				log('🐘 serviceCreate postgres (postgres:16-alpine) OK');
				pgPassword = crypto.randomBytes(18).toString('base64url');
				await client.variableUpsert(state.projectId, state.environmentId, st.serviceId, 'POSTGRES_PASSWORD', pgPassword);
				await client.variableUpsert(state.projectId, state.environmentId, st.serviceId, 'PGDATA', '/var/lib/postgresql/data/pgdata');
				log('🔐 POSTGRES_PASSWORD + PGDATA set (value not logged)');
			}
			await client.serviceInstanceDeploy(st.serviceId, state.environmentId);
			log('🚀 postgres deploy triggered -- ⏳ waiting for green');
			await verifyStep(st, 'postgres');
			return;
		}
		case 'redis': {
			if (!st.serviceId) {
				const r = await client.serviceCreate(state.projectId, 'redis', stepDef(st.id).image);
				st.serviceId = r.serviceId;
				log('🟥 serviceCreate redis (redis:7-alpine) OK');
			} else {
				await client.serviceInstanceDeploy(st.serviceId, state.environmentId);
			}
			log('🚀 redis deploying -- ⏳ waiting for green');
			await verifyStep(st, 'redis');
			return;
		}
		case 'web': {
			if (!st.serviceId) {
				const r = await client.serviceCreate(state.projectId, 'web', stepDef(st.id).image);
				st.serviceId = r.serviceId;
				log('🌐 serviceCreate web (nginx:alpine) OK');
				const d = await client.serviceDomainCreate(st.serviceId, state.environmentId, 80);
				state.webDomain = d.domain;
				emit({ kind: 'domain', domain: state.webDomain });
				log('🔗 Domain created: https://' + d.domain);
			} else {
				await client.serviceInstanceDeploy(st.serviceId, state.environmentId);
			}
			log('🚀 web deploying -- ⏳ waiting for green');
			await verifyStep(st, 'web');
			return;
		}
		case 'worker': {
			if (!st.serviceId) {
				const r = await client.serviceCreate(state.projectId, 'worker', stepDef(st.id).image);
				st.serviceId = r.serviceId;
				log('🐝 serviceCreate worker (busybox:stable) OK');
				await client.serviceInstanceUpdate(st.serviceId, state.environmentId, {
					startCommand: 'sh -c \'while true; do echo "[fly-worker] buzz"; sleep 30; done\'',
				});
			}
			await client.serviceInstanceDeploy(st.serviceId, state.environmentId);
			log('🚀 worker deploying -- ⏳ waiting for green');
			await verifyStep(st, 'worker');
			return;
		}
		case 'wire-vars': {
			const workerStep = step('worker');
			st.serviceId = workerStep.serviceId;
			await client.variableUpsert(state.projectId, state.environmentId, st.serviceId,
				'DATABASE_URL',
				'postgresql://postgres:' + pgPassword + '@postgres.railway.internal:5432/postgres');
			await client.variableUpsert(state.projectId, state.environmentId, st.serviceId,
				'REDIS_URL', 'redis://redis.railway.internal:6379');
			log('🧵 DATABASE_URL + REDIS_URL wired to worker via *.railway.internal');
			await client.serviceInstanceDeploy(st.serviceId, state.environmentId);
			log('🚀 worker redeploying with wired vars -- ⏳ waiting for green');
			await verifyStep(st, 'worker');
			return;
		}
		default:
			throw new Error('unknown step ' + st.id);
		}
	}

	async function verifyStep(st, serviceName) {
		setStepState(st, 'VERIFYING');
		const r = await poller.waitForDeploy(
			state.projectId, state.environmentId, st.serviceId, onStatuses);
		// A mid-verify SWAT/abort wins: don't advance or retry a dead mission
		if (!missionActive()) return;
		if (r.status === 'SUCCESS') {
			setServiceStatus(serviceName, 'SUCCESS');
			stepDone(st);
		} else {
			setServiceStatus(serviceName, r.status === 'TIMEOUT' ? 'FAILED' : r.status);
			log('💥 Deployment ' + r.status + ' for ' + serviceName);
			await stepFailed(st);
		}
	}

	function stepDone(st) {
		setStepState(st, 'DONE');
		log('✅ ' + st.title + ' -- GREEN');
		advance();
	}

	async function stepFailed(st) {
		st.retries++;
		setStepState(st, 'FAILED');
		emit({ kind: 'node-failed', stepId: st.id });
		// Real pain: one-shot 5x NOCI stimulus -> emergent startle response
		behavior.triggerNociception();
		log('⚡ NOCI pathway fired -- the fly startles away from the failure');
		if (client.dryRunAckFailure && st.serviceId) client.dryRunAckFailure(st.serviceId);
		if (st.retries >= MAX_RETRIES) {
			log('🛑 ' + st.title + ' failed ' + MAX_RETRIES + ' times -- mission ABORTED');
			setMissionState('ABORTED');
			return;
		}
		log('⏲️ Retrying "' + st.title + '" in ' + (FAILURE_COOLDOWN_MS / 1000) + 's (attempt ' + (st.retries + 1) + '/' + MAX_RETRIES + ')');
		setTimeout(function () {
			if (missionActive()) {
				makeAvailable(st);
			}
		}, FAILURE_COOLDOWN_MS);
	}

	function advance() {
		const next = state.steps.find(function (s) { return s.state === 'LOCKED'; });
		if (next) {
			if (state.mission === 'ARMED') setMissionState('RUNNING');
			makeAvailable(next);
			return;
		}
		// All steps done -> confirm every service is green
		const names = ['postgres', 'redis', 'web', 'worker'];
		const allGreen = names.every(function (n) { return state.serviceStatuses[n] === 'SUCCESS'; });
		if (allGreen) {
			setMissionState('ALL_GREEN');
			behavior.setHungerFloor(0);
			behavior.celebrate();
			emit({ kind: 'celebration', domain: state.webDomain, projectUrl: state.projectUrl });
			log('🎉 ALL GREEN -- the fly brain built a 4-service app around itself on Railway!');
			if (state.webDomain) log('🌐 Live at https://' + state.webDomain);
			if (teardownAfterMin > 0) {
				log('⏲️ Auto-teardown in ' + teardownAfterMin + ' min');
				teardownTimer = setTimeout(function () { teardown(); }, teardownAfterMin * 60 * 1000);
			}
		} else {
			log('⚠️ Steps done but not all services green: ' + JSON.stringify(state.serviceStatuses));
		}
	}

	/* ---- public API ---- */

	async function start() {
		if (state.mission !== 'IDLE' && state.mission !== 'TORN_DOWN' && state.mission !== 'ABORTED') {
			return { ok: false, code: 409, error: 'mission already ' + state.mission };
		}
		if (spawnedServiceIds().length > 0) {
			return { ok: false, code: 409, error: 'previously spawned services still exist -- teardown first' };
		}
		try {
			const ctx = await client.resolveProjectContext();
			state.projectId = ctx.projectId;
			state.environmentId = ctx.environmentId;
			state.projectUrl = client.dryRun ? null : 'https://railway.com/project/' + ctx.projectId;
		} catch (err) {
			return { ok: false, code: 409, error: err.message };
		}
		resetInternal();
		state.startedAt = Date.now();
		setMissionState('ARMED');
		emit({ kind: 'project', projectId: state.projectId, projectUrl: state.projectUrl });
		log('🎬 Mission armed' + (client.dryRun ? ' (DRY RUN -- no real mutations)' : ' -- the fly will build REAL services around itself in project ' + state.projectId));
		if (!client.dryRun) {
			log('🌍 Tip: set this project to public in its settings so spectators can verify on Railway\'s dashboard');
		}
		makeAvailable(state.steps[0]);
		return { ok: true };
	}

	async function teardown() {
		if (teardownTimer) { clearTimeout(teardownTimer); teardownTimer = null; }
		const ids = spawnedServiceIds();
		if (ids.length === 0) {
			if (missionActive()) {
				// Nothing spawned yet -- swat just calls off the hunt
				setMissionState('ABORTED');
				behavior.clearFood();
				behavior.setHungerFloor(0);
				log('🖐️ SWAT! Mission called off before anything was spawned.');
				return { ok: true };
			}
			return { ok: false, code: 409, error: 'no spawned services to tear down' };
		}
		// Flip state first so any in-flight verify loop stands down
		setMissionState('TORN_DOWN');
		log('🖐️ SWAT! Deleting ' + ids.length + ' spawned service(s) -- the fly itself survives...');
		const failures = [];
		for (const id of ids) {
			try {
				await client.serviceDelete(id, state.environmentId);
			} catch (err) {
				failures.push(id + ': ' + err.message);
			}
		}
		if (failures.length) {
			log('❌ Teardown incomplete: ' + failures.join('; '));
			return { ok: false, code: 502, error: 'some services not deleted: ' + failures.join('; ') };
		}
		for (const st of state.steps) st.serviceId = null;
		state.webDomain = null;
		state.serviceStatuses = {};
		behavior.clearFood();
		behavior.setHungerFloor(0);
		emit({ kind: 'services', statuses: {} });
		log('🗑️ Spawned services deleted. The fly rests on the empty canvas.');
		return { ok: true };
	}

	function resetInternal() {
		for (const st of state.steps) {
			st.state = 'LOCKED';
			st.retries = 0;
			st.serviceId = null;
			st.detail = '';
		}
		state.serviceStatuses = {};
		state.webDomain = null;
		pgPassword = null;
		behavior.clearFood();
		behavior.setHungerFloor(0);
	}

	function reset() {
		if (spawnedServiceIds().length > 0) {
			return { ok: false, code: 409, error: 'spawned services still exist -- teardown first' };
		}
		if (missionActive()) {
			return { ok: false, code: 409, error: 'mission is running -- teardown first' };
		}
		resetInternal();
		setMissionState('IDLE');
		log('🔄 Mission reset');
		return { ok: true };
	}

	function snapshot() {
		return {
			mission: state.mission,
			projectId: state.projectId,
			projectUrl: state.projectUrl,
			webDomain: state.webDomain,
			serviceStatuses: state.serviceStatuses,
			startedAt: state.startedAt,
			steps: state.steps.map(function (s) {
				return {
					id: s.id, title: s.title, node: s.node,
					state: s.state, retries: s.retries, detail: s.detail,
				};
			}),
			log: state.log.slice(-80),
		};
	}

	behavior.setOnFoodConsumed(function (stepId) { onFoodConsumed(stepId); });

	return {
		start: start,
		teardown: teardown,
		reset: reset,
		snapshot: snapshot,
		get state() { return state.mission; },
	};
}

module.exports = { createMission };
