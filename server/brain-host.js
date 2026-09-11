/* brain-host.js
 *
 * Server-side port of flybrain's brain-worker-bridge.js. Runs the vendored
 * behavioral connectome (constants.js + connectome.js + fly-logic.js) inside
 * a vm sandbox, spawns the LIF sim as a worker_thread (via sim-worker-shim),
 * and translates BRAIN.stimulate/drives <-> worker messages exactly like the
 * browser bridge did. No DOM, no XHR: connectome loaded from disk.
 *
 * Tuning numbers (STIM_INTENSITY, FIRE_STATE_SCALE, MOTOR_SCALE) are kept
 * identical to upstream.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');

const STIM_INTENSITY = 0.15;
const FIRE_STATE_SCALE = 100;
const MOTOR_SCALE = 0.6;

const ROOT = path.join(__dirname, '..');

function createBrainHost(opts) {
	opts = opts || {};
	const onSpikeTick = opts.onSpikeTick || null; // (groupSpikeCounts, firedNeurons, tickCount)
	const log = opts.log || function () {};

	/* ---- vm sandbox running the vendored behavioral layer ---- */
	const sandbox = { console: console, Math: Math, Date: Date };
	vm.createContext(sandbox);
	function runVendored(file) {
		const src = fs.readFileSync(path.join(ROOT, 'vendor-sim', file), 'utf8');
		vm.runInContext(src, sandbox, { filename: 'vendor-sim/' + file });
	}
	runVendored('constants.js');
	runVendored('connectome.js');
	// fly-logic.js references globals `behavior`, `food`, `fly` defined later
	// by server/behavior.js in this same sandbox.
	runVendored('fly-logic.js');

	const BRAIN = sandbox.BRAIN;
	BRAIN.setup();

	/* ---- module state (mirrors bridge closure state) ---- */
	let worker = null;
	let workerReady = false;
	let latestFireState = null;
	let neuronCount = 0;
	let groupCount = 0;
	let groupIdArr = null;
	let regionTypeArr = null;
	let groupIndices = null;
	let groupSizes = null;
	const groupNameToId = {};
	const groupIdToName = [];
	let pendingGroupSpikes = null;
	let pendingWorkerTicks = 0;
	let pendingDriveFrames = 0;
	let lastStats = null;
	const groupRegions = [];

	const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'neuron_meta.json'), 'utf8'));
	groupCount = meta.group_count;
	groupSizes = meta.group_sizes;
	for (const g of meta.groups) {
		groupNameToId[g.name] = g.id;
		groupIdToName[g.id] = g.name;
		groupRegions[g.id] = g.region;
	}

	/* ---- worker lifecycle ---- */
	const readyPromise = new Promise(function (resolve, reject) {
		const binBuf = fs.readFileSync(path.join(ROOT, 'data', 'connectome.bin.gz'));
		const buffer = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
		worker = new Worker(path.join(__dirname, 'sim-worker-shim.js'));
		worker.unref();
		worker.on('error', function (err) {
			log('sim worker crashed: ' + (err && err.message));
			workerReady = false;
			if (!neuronCount) reject(err);
		});
		worker.on('message', function (data) {
			switch (data.type) {
			case 'ready':
				neuronCount = data.neuronCount;
				groupIdArr = data.groupId;
				regionTypeArr = data.regionType;
				pendingGroupSpikes = new Float32Array(groupCount);
				pendingWorkerTicks = 0;
				buildGroupIndices();
				workerReady = true;
				BRAIN.workerReady = true;
				BRAIN.workerNeuronCount = neuronCount;
				BRAIN.workerEdgeCount = data.edgeCount;
				for (const ps in BRAIN.postSynaptic) {
					BRAIN.postSynaptic[ps][0] = 0;
					BRAIN.postSynaptic[ps][1] = 0;
				}
				worker.postMessage({ type: 'start' });
				log('Connectome worker ready: ' + neuronCount + ' neurons, ' + data.edgeCount + ' edges');
				resolve(host);
				break;
			case 'tick':
				latestFireState = data.fireState;
				BRAIN.latestFireState = data.fireState;
				BRAIN.workerFiredNeurons = data.firedNeurons || 0;
				if (pendingGroupSpikes && data.groupSpikeCounts) {
					for (let g = 0; g < groupCount; g++) {
						pendingGroupSpikes[g] += data.groupSpikeCounts[g] || 0;
					}
					pendingWorkerTicks++;
				}
				if (onSpikeTick && data.groupSpikeCounts) {
					onSpikeTick(data.groupSpikeCounts, data.firedNeurons || 0, data.tickCount);
				}
				break;
			case 'stats':
				lastStats = data;
				break;
			case 'error':
				log('sim worker error: ' + data.message);
				break;
			}
		});
		worker.postMessage({ type: 'init', buffer: buffer }, [buffer]);
	});

	function buildGroupIndices() {
		const counts = new Uint32Array(groupCount);
		for (let i = 0; i < neuronCount; i++) counts[groupIdArr[i]]++;
		groupIndices = new Array(groupCount);
		for (let g = 0; g < groupCount; g++) {
			groupIndices[g] = new Uint32Array(counts[g]);
			counts[g] = 0;
		}
		for (let i = 0; i < neuronCount; i++) {
			const gid = groupIdArr[i];
			groupIndices[gid][counts[gid]++] = i;
		}
	}

	/* ---- virtual VNC motor layer (verbatim port) ---- */

	function readPS(name) {
		if (!BRAIN.postSynaptic[name]) return 0;
		return BRAIN.postSynaptic[name][BRAIN.nextState] || 0;
	}

	function addPS(name, val) {
		if (!BRAIN.postSynaptic[name]) return;
		BRAIN.postSynaptic[name][BRAIN.nextState] += val;
	}

	function synthesizeMotorOutputs() {
		let desc = readPS('GNG_DESC');
		const vcpg = readPS('VNC_CPG');

		const cxPfn = readPS('CX_PFN');
		const cxFc = readPS('CX_FC');
		const cxEpg = readPS('CX_EPG');
		const sezFeed = readPS('SEZ_FEED');
		const sezGroom = readPS('SEZ_GROOM');
		const mbApp = readPS('MB_MBON_APP');
		const mbAv = readPS('MB_MBON_AV');
		const lhApp = readPS('LH_APP');
		const lhAv = readPS('LH_AV');
		const dFear = readPS('DRIVE_FEAR');
		const dGroom = readPS('DRIVE_GROOM');
		const prob = readPS('MN_PROBOSCIS');
		const dnStartle = readPS('DN_STARTLE');
		const noci = readPS('NOCI');

		const walkIntent = (cxPfn + cxFc + cxEpg) * 0.3 + (mbApp + lhApp) * 0.5 + (desc + vcpg) * 0.2;
		const flightIntent = dFear * 2.0 + (mbAv + lhAv) * 0.8 + dnStartle * 1.5 + noci * 1.0;
		const groomIntent = dGroom * 1.5 + sezGroom * 1.0;
		const feedIntent = sezFeed * 1.0 + prob * 0.5;
		const descProxy = Math.max(
			walkIntent * 0.45,
			flightIntent * 0.35,
			groomIntent * 0.3,
			feedIntent * 0.25
		);
		if (descProxy > desc) {
			desc = descProxy;
			if (BRAIN.postSynaptic.GNG_DESC) {
				BRAIN.postSynaptic.GNG_DESC[BRAIN.nextState] = desc;
			}
		}
		const total = desc + vcpg;
		if (total < 0.5) return;

		const baseWalk = total * MOTOR_SCALE;
		const walkDrive = baseWalk * (1.0 + walkIntent * 0.1);

		const jitter = (Math.random() - 0.5) * 0.04;
		const walkL = walkDrive * (1.0 + jitter) / 3.0;
		const walkR = walkDrive * (1.0 - jitter) / 3.0;

		addPS('MN_LEG_L1', walkL);
		addPS('MN_LEG_L2', walkL);
		addPS('MN_LEG_L3', walkL);
		addPS('MN_LEG_R1', walkR);
		addPS('MN_LEG_R2', walkR);
		addPS('MN_LEG_R3', walkR);

		if (flightIntent > 1.0) {
			const flightDrive = flightIntent * MOTOR_SCALE * 0.7;
			addPS('MN_WING_L', flightDrive);
			addPS('MN_WING_R', flightDrive);
		}

		if (dFear > 3.0) {
			addPS('DN_STARTLE', dFear * MOTOR_SCALE);
		}

		if (groomIntent > 1.0) {
			addPS('MN_ABDOMEN', groomIntent * MOTOR_SCALE * 0.3);
		}

		if (feedIntent > 0.5) {
			addPS('MN_PROBOSCIS', feedIntent * MOTOR_SCALE * 0.3);
		}
	}

	/* ---- stimulation translation (verbatim port) ---- */

	function collectOneShotSegments() {
		const segs = [];
		if (BRAIN.stimulate.nociception) {
			segs.push({ name: 'NOCI', intensity: STIM_INTENSITY * 5 });
			BRAIN.stimulate.nociception = false;
		}
		return segs;
	}

	function collectStimulationSegments() {
		const segs = [];
		const d = BRAIN.drives;
		let pulses;

		if (d.hunger > 0.2) {
			pulses = d.hunger > 0.6 ? 3 : (d.hunger > 0.4 ? 2 : 1);
			segs.push({ name: 'DRIVE_HUNGER', intensity: STIM_INTENSITY * d.hunger * pulses });
		}
		if (d.fear > 0.05) {
			pulses = d.fear > 0.5 ? 3 : (d.fear > 0.2 ? 2 : 1);
			segs.push({ name: 'DRIVE_FEAR', intensity: STIM_INTENSITY * d.fear * pulses });
		}
		if (d.fatigue > 0.3) {
			segs.push({ name: 'DRIVE_FATIGUE', intensity: STIM_INTENSITY * d.fatigue });
		}
		if (d.curiosity > 0.2) {
			pulses = d.curiosity > 0.5 ? 2 : 1;
			segs.push({ name: 'DRIVE_CURIOSITY', intensity: STIM_INTENSITY * d.curiosity * pulses });
		}
		if (d.groom > 0.3) {
			segs.push({ name: 'DRIVE_GROOM', intensity: STIM_INTENSITY * d.groom });
		}

		if (BRAIN.stimulate.touch) {
			segs.push({ name: 'MECH_BRISTLE', intensity: STIM_INTENSITY });
			if (BRAIN.stimulate.touchLocation === 'head' ||
				BRAIN.stimulate.touchLocation === 'thorax') {
				segs.push({ name: 'MECH_BRISTLE', intensity: STIM_INTENSITY });
			}
		}
		if (BRAIN.stimulate.foodNearby) {
			segs.push({ name: 'OLF_ORN_FOOD', intensity: STIM_INTENSITY });
		}
		if (BRAIN.stimulate.foodContact) {
			segs.push({ name: 'GUS_GRN_SWEET', intensity: STIM_INTENSITY });
		}
		if (BRAIN.stimulate.dangerOdor) {
			segs.push({ name: 'OLF_ORN_DANGER', intensity: STIM_INTENSITY });
		}
		if (BRAIN.stimulate.wind) {
			segs.push({ name: 'MECH_JO', intensity: STIM_INTENSITY * BRAIN.stimulate.windStrength });
		}
		if (BRAIN.stimulate.lightLevel > 0.2) {
			segs.push({ name: 'VIS_R1R6', intensity: STIM_INTENSITY * BRAIN.stimulate.lightLevel });
			segs.push({ name: 'VIS_R7R8', intensity: STIM_INTENSITY * BRAIN.stimulate.lightLevel * 0.7 });
		}
		if (BRAIN.stimulate.temperature > 0.65) {
			const warmIntensity = (BRAIN.stimulate.temperature - 0.5) * 2;
			segs.push({ name: 'THERMO_WARM', intensity: STIM_INTENSITY * warmIntensity });
		} else if (BRAIN.stimulate.temperature < 0.35) {
			const coolIntensity = (0.5 - BRAIN.stimulate.temperature) * 2;
			segs.push({ name: 'THERMO_COOL', intensity: STIM_INTENSITY * coolIntensity });
		}
		if (BRAIN._isMoving) {
			segs.push({ name: 'MECH_CHORD', intensity: STIM_INTENSITY });
		}
		if (BRAIN.stimulate.lightLevel > 0.1 && BRAIN._isMoving) {
			segs.push({ name: 'VIS_LPTC', intensity: STIM_INTENSITY * 0.3 });
		}

		const tonicIntensity = BRAIN.stimulate.lightLevel === 0 ? 0.03 : 0.08;
		segs.push({ name: 'CX_FC', intensity: tonicIntensity });
		segs.push({ name: 'CX_EPG', intensity: tonicIntensity });
		segs.push({ name: 'CX_PFN', intensity: tonicIntensity });

		return segs;
	}

	function sendOneShotStimuli() {
		const segs = collectOneShotSegments();
		if (!worker || !workerReady || segs.length === 0) return;
		for (const seg of segs) {
			const gid = groupNameToId[seg.name];
			if (gid === undefined) continue;
			const idx = groupIndices[gid];
			if (!idx || idx.length === 0) continue;
			const intensities = new Float32Array(idx.length);
			intensities.fill(seg.intensity);
			worker.postMessage({ type: 'stimulate', indices: idx, intensities: intensities });
		}
	}

	function sendStimulation() {
		if (!worker || !workerReady) return;

		const segs = collectStimulationSegments();

		let totalLen = 0;
		const indexedSegs = [];
		for (const seg of segs) {
			const gid = groupNameToId[seg.name];
			if (gid === undefined) continue;
			const idx = groupIndices[gid];
			if (!idx || idx.length === 0) continue;
			indexedSegs.push({ indices: idx, intensity: seg.intensity });
			totalLen += idx.length;
		}

		if (totalLen === 0) {
			worker.postMessage({ type: 'setStimulusState', indices: null, intensities: null });
			return;
		}

		const allIndices = new Uint32Array(totalLen);
		const allIntensities = new Float32Array(totalLen);
		let offset = 0;
		for (const seg of indexedSegs) {
			allIndices.set(seg.indices, offset);
			allIntensities.fill(seg.intensity, offset, offset + seg.indices.length);
			offset += seg.indices.length;
		}

		worker.postMessage({ type: 'setStimulusState', indices: allIndices, intensities: allIntensities });
	}

	/* ---- aggregate fire state into BRAIN.postSynaptic (verbatim port) ---- */

	function aggregateFireState() {
		const groupFires = new Float32Array(groupCount);
		let tickWindow = pendingWorkerTicks;

		if (pendingGroupSpikes && pendingWorkerTicks > 0) {
			groupFires.set(pendingGroupSpikes);
		} else if (latestFireState) {
			const fire = latestFireState;
			tickWindow = 1;
			for (let i = 0; i < neuronCount; i++) {
				if (fire[i]) {
					groupFires[groupIdArr[i]]++;
				}
			}
		}

		if (tickWindow < 1) tickWindow = 1;

		for (let g = 0; g < groupCount; g++) {
			const name = groupIdToName[g];
			if (!name || !BRAIN.postSynaptic[name]) continue;
			const size = groupSizes[g];
			const windowActivation = size > 0
				? (groupFires[g] / (size * tickWindow)) * FIRE_STATE_SCALE
				: 0;
			const prevActivation = BRAIN.postSynaptic[name][BRAIN.thisState] || 0;
			const activation = Math.max(windowActivation, prevActivation * 0.75);
			BRAIN.postSynaptic[name][BRAIN.nextState] = activation;
		}

		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		latestFireState = null;
	}

	/* ---- worker-driven BRAIN.update (verbatim port of workerUpdate) ---- */

	function workerUpdate() {
		pendingDriveFrames = Math.min(pendingDriveFrames + 1, 20);

		sendOneShotStimuli();

		if (latestFireState || pendingWorkerTicks > 0) {
			for (let i = 0; i < pendingDriveFrames; i++) {
				BRAIN.updateDrives();
			}
			pendingDriveFrames = 0;

			sendStimulation();
			aggregateFireState();

			const vd = BRAIN.drives;
			if (BRAIN.postSynaptic['DRIVE_FEAR'])
				BRAIN.postSynaptic['DRIVE_FEAR'][BRAIN.nextState] = vd.fear * FIRE_STATE_SCALE;
			if (BRAIN.postSynaptic['DRIVE_CURIOSITY'])
				BRAIN.postSynaptic['DRIVE_CURIOSITY'][BRAIN.nextState] = vd.curiosity * FIRE_STATE_SCALE;
			if (BRAIN.postSynaptic['DRIVE_GROOM'])
				BRAIN.postSynaptic['DRIVE_GROOM'][BRAIN.nextState] = vd.groom * FIRE_STATE_SCALE;

			synthesizeMotorOutputs();

			BRAIN.motorcontrol();

			for (const ps in BRAIN.postSynaptic) {
				BRAIN.postSynaptic[ps][BRAIN.thisState] =
					BRAIN.postSynaptic[ps][BRAIN.nextState];
			}
			const temp = BRAIN.thisState;
			BRAIN.thisState = BRAIN.nextState;
			BRAIN.nextState = temp;
		}
	}

	BRAIN.update = workerUpdate;

	/* ---- host handle ---- */

	const host = {
		sandbox: sandbox,
		BRAIN: BRAIN,
		ready: readyPromise,
		update: workerUpdate,
		get workerReady() { return workerReady; },
		get neuronCount() { return neuronCount; },
		get edgeCount() { return BRAIN.workerEdgeCount || 0; },
		get stats() { return lastStats; },
		groupMeta: {
			count: groupCount,
			names: groupIdToName,
			sizes: groupSizes,
			regions: groupRegions,
		},
		terminate: function () {
			if (worker) worker.terminate();
		},
	};

	return host;
}

module.exports = { createBrainHost };
