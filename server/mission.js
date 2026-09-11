/* mission.js
 *
 * Mission state machine. Defines WHAT step is next; the brain decides WHEN
 * and HOW: each pending step manifests as food at that service's node on the
 * board. When the fly's emergent feed behavior finishes eating the food, the
 * step's real Railway GraphQL mutations fire (in-process). Deploy failures
 * trigger the NOCI nociception pathway (emergent startle), then the step
 * re-arms after a cooldown.
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
		id: 'create-project',
		title: 'Create project',
		node: { x: 800, y: 150 },
		serviceName: null,
	},
	{
		id: 'postgres',
		title: 'Deploy Postgres',
		node: { x: 280, y: 320 },
		serviceName: 'postgres',
		image: 'postgres:16-alpine',
	},
	{
		id: 'redis',
		title: 'Deploy Redis',
		node: { x: 1320, y: 320 },
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
	const projectName = deps.projectName || process.env.MISSION_PROJECT_NAME || 'fly-deployed-app';
	const teardownAfterMin = Number(deps.teardownAfterMin || process.env.TEARDOWN_AFTER_MIN || 0);

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
			// Map by known service names only (dry-run uses the same names)
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
		case 'create-project': {
			const r = await client.projectCreate(projectName);
			state.projectId = r.projectId;
			state.environmentId = r.environmentId;
			state.projectUrl = client.dryRun
				? null
				: 'https://railway.com/project/' + r.projectId;
			emit({ kind: 'project', projectId: state.projectId, projectUrl: state.projectUrl });
			log('📦 projectCreate OK -- project ' + r.projectId);
			const pub = await client.projectMakePublic(r.projectId);
			if (pub) log('🌍 Project set public (read-only) -- spectators can verify on Railway\'s dashboard');
			stepDone(st);
			return;
		}
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
			if (state.mission === 'RUNNING' || state.mission === 'ARMED') {
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
			behavior.celebrate();
			emit({ kind: 'celebration', domain: state.webDomain, projectUrl: state.projectUrl });
			log('🎉 ALL GREEN -- the fly brain deployed a ' + names.length + '-service app on Railway!');
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

	function start() {
		if (state.mission !== 'IDLE' && state.mission !== 'TORN_DOWN' && state.mission !== 'ABORTED') {
			return { ok: false, code: 409, error: 'mission already ' + state.mission };
		}
		if (state.projectId) {
			return { ok: false, code: 409, error: 'previous project still exists -- teardown first' };
		}
		resetInternal();
		state.startedAt = Date.now();
		setMissionState('ARMED');
		log('🎬 Mission armed' + (client.dryRun ? ' (DRY RUN -- no real mutations)' : ' -- REAL Railway deploys ahead'));
		makeAvailable(state.steps[0]);
		return { ok: true };
	}

	async function teardown() {
		if (teardownTimer) { clearTimeout(teardownTimer); teardownTimer = null; }
		if (!state.projectId) {
			return { ok: false, code: 409, error: 'no project to tear down' };
		}
		try {
			log('🖐️ SWAT! Deleting project ' + state.projectId + '...');
			await client.projectDelete(state.projectId);
			state.projectId = null;
			state.projectUrl = null;
			state.webDomain = null;
			state.serviceStatuses = {};
			behavior.clearFood();
			behavior.setHungerFloor(0);
			setMissionState('TORN_DOWN');
			emit({ kind: 'services', statuses: {} });
			log('🗑️ Project deleted. The fly rests.');
			return { ok: true };
		} catch (err) {
			log('❌ Teardown failed: ' + err.message);
			return { ok: false, code: 502, error: err.message };
		}
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
		state.projectUrl = null;
		pgPassword = null;
		behavior.clearFood();
		behavior.setHungerFloor(0);
	}

	function reset() {
		if (state.projectId) {
			return { ok: false, code: 409, error: 'project still exists -- teardown first' };
		}
		if (state.mission === 'RUNNING' || state.mission === 'ARMED') {
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
