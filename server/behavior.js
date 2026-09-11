/* behavior.js
 *
 * Server-authoritative port of flybrain main.js's behavioral layer: the fly
 * object, behavior FSM (updateBehaviorState / evaluateBehaviorEntry from the
 * vendored fly-logic.js), movement computation, and the food/feeding loop.
 * All canvas/DOM/tool code is stripped; the sim runs continuously regardless
 * of viewers. Behavior tuning numbers are unchanged from upstream.
 *
 * Mission integration:
 *  - spawnFood(x, y, stepId): places food at a service node's coordinates
 *  - onFoodConsumed(stepId): fired when the fly finishes eating (feed
 *    progress >= 1) -- the mission executes the real GraphQL mutation there
 *  - setHungerFloor(v): mission nudge; clamps hunger up while a step is
 *    AVAILABLE so the existing hunger>0.7 && foodNearby feed path engages
 *  - triggerNociception(): deploy failure -> NOCI pathway -> emergent startle
 */
'use strict';

const WORLD = { w: 1600, h: 900 };

const BEHAVIOR_MIN_DURATION = {
	idle: 0,
	walk: 500,
	explore: 1000,
	phototaxis: 1000,
	rest: 3000,
	groom: 2000,
	feed: 2000,
	fly: 1500,
	startle: 800,
	brace: 500,
};

const BEHAVIOR_COOLDOWN = {
	startle: 2000,
	fly: 1000,
	groom: 3000,
	feed: 1000,
	brace: 1000,
};

function createBehavior(host, opts) {
	opts = opts || {};
	const BRAIN = host.BRAIN;
	const sandbox = host.sandbox;
	const log = opts.log || function () {};

	/* ---- world objects, shared with the vendored fly-logic.js sandbox ---- */
	const fly = { x: WORLD.w / 2, y: WORLD.h / 2 };
	const food = [];
	const behavior = {
		current: 'idle',
		enterTime: Date.now(),
		cooldowns: {},
		startlePhase: 'none',
		startleFreezeEnd: 0,
		groomLocation: null,
		burstDir: 0,
	};
	sandbox.fly = fly;
	sandbox.food = food;
	sandbox.behavior = behavior;

	/* ---- movement state ---- */
	let facingDir = 0;
	let targetDir = 0;
	let speed = 0;
	let targetSpeed = 0;
	let speedChangeInterval = 0;
	let touchResetTime = 0;
	let hungerFloor = 0;
	let onFoodConsumed = null;

	// Fixed ambient light keeps locomotion alive. Held below the phototaxis
	// threshold (0.5) so light-seeking toward board center doesn't outcompete
	// odor-driven food seeking toward the mission's service nodes.
	BRAIN.stimulate.lightLevel = 0.4;

	const normalizeAngle = sandbox.normalizeAngle;
	const evaluateBehaviorEntry = sandbox.evaluateBehaviorEntry;

	function nearestFood() {
		let best = null;
		let bestDist = Infinity;
		for (let i = 0; i < food.length; i++) {
			const d = Math.hypot(fly.x - food[i].x, fly.y - food[i].y);
			if (d < bestDist) {
				bestDist = d;
				best = food[i];
			}
		}
		if (!best) return null;
		return { item: best, dist: bestDist };
	}

	function syncBrainFlags() {
		const s = behavior.current;
		BRAIN._isMoving = (s === 'walk' || s === 'explore' || s === 'phototaxis' ||
			s === 'fly' || (s === 'startle' && behavior.startlePhase === 'burst'));
		BRAIN._isFeeding = (s === 'feed');
		BRAIN._isGrooming = (s === 'groom');
	}

	function updateBehaviorState() {
		const now = Date.now();
		const elapsed = now - behavior.enterTime;
		const minDur = BEHAVIOR_MIN_DURATION[behavior.current] || 0;

		if (elapsed < minDur) {
			syncBrainFlags();
			return;
		}

		const newState = evaluateBehaviorEntry();

		if (newState !== behavior.current) {
			if (BEHAVIOR_COOLDOWN[behavior.current]) {
				behavior.cooldowns[behavior.current] = now + BEHAVIOR_COOLDOWN[behavior.current];
			}
			if (behavior.current === 'feed') {
				for (let fi = 0; fi < food.length; fi++) {
					if (food[fi].feedStart !== 0) {
						const ate = Date.now() - food[fi].feedStart;
						food[fi].eaten = Math.min(1, (food[fi].eaten || 0) + ate / food[fi].feedDuration);
						food[fi].feedStart = 0;
					}
				}
			}
			behavior.current = newState;
			behavior.enterTime = now;

			if (newState === 'startle') {
				behavior.startlePhase = 'freeze';
				behavior.startleFreezeEnd = now + 200;
				if (BRAIN.postSynaptic['DN_STARTLE']) {
					BRAIN.postSynaptic['DN_STARTLE'][BRAIN.thisState] = 0;
					BRAIN.postSynaptic['DN_STARTLE'][BRAIN.nextState] = 0;
				}
			} else {
				behavior.startlePhase = 'none';
			}

			if (newState === 'groom') {
				behavior.groomLocation = BRAIN.stimulate.touchLocation || 'thorax';
			}
		}

		syncBrainFlags();
	}

	function computeMovementForBehavior() {
		const scalingFactor = 20;
		const state = behavior.current;

		if (state === 'walk' || state === 'explore') {
			let newDir = (BRAIN.accumleft - BRAIN.accumright) / scalingFactor;
			newDir = Math.max(-0.05, Math.min(0.05, newDir));
			targetDir = facingDir + newDir * Math.PI;
			targetSpeed = (Math.abs(BRAIN.accumleft) + Math.abs(BRAIN.accumright)) / (scalingFactor * 5);
			speedChangeInterval = (targetSpeed - speed) / (scalingFactor * 1.5);
			if (state === 'explore') {
				targetDir += (Math.random() - 0.5) * 0.3;
			}
			if (BRAIN.stimulate.foodNearby && BRAIN.drives.hunger > 0.3) {
				const nf = nearestFood();
				if (nf) {
					const foodAngle = Math.atan2(-(nf.item.y - fly.y), nf.item.x - fly.x);
					const seekStrength = Math.min(1, BRAIN.drives.hunger);
					const angleDiffToFood = normalizeAngle(foodAngle - facingDir);
					targetDir = facingDir + angleDiffToFood * seekStrength;
					if (targetSpeed < 0.3) targetSpeed = 0.3;
					speedChangeInterval = (targetSpeed - speed) / (scalingFactor * 1.5);
				}
			}
			if (BRAIN.accumHead > 3) {
				const headBias = Math.min((BRAIN.accumHead / 40) * 0.15, 0.08);
				const headSign = (BRAIN.accumWalkLeft - BRAIN.accumWalkRight > 0) ? 1 : -1;
				targetDir += headBias * headSign;
			}
		} else if (state === 'phototaxis') {
			const dx = WORLD.w / 2 - fly.x;
			const dy = -(WORLD.h / 2 - fly.y);
			targetDir = Math.atan2(dy, dx);
			targetSpeed = (Math.abs(BRAIN.accumleft) + Math.abs(BRAIN.accumright)) / (scalingFactor * 5);
			if (targetSpeed < 0.3) targetSpeed = 0.3;
			speedChangeInterval = (targetSpeed - speed) / (scalingFactor * 1.5);
		} else if (state === 'fly') {
			const newDir = (BRAIN.accumleft - BRAIN.accumright) / scalingFactor;
			targetDir = facingDir + newDir * Math.PI + (Math.random() - 0.5) * 0.2;
			targetSpeed = ((Math.abs(BRAIN.accumleft) + Math.abs(BRAIN.accumright)) / (scalingFactor * 5)) * 2.5;
			if (targetSpeed < 1.5) targetSpeed = 1.5;
			speedChangeInterval = (targetSpeed - speed) / (scalingFactor * 0.5);
		} else if (state === 'startle') {
			if (behavior.startlePhase === 'freeze') {
				targetSpeed = 0;
				speedChangeInterval = -speed * 0.5;
			} else {
				targetDir = behavior.burstDir;
				targetSpeed = 0.5;
				speedChangeInterval = (targetSpeed - speed) / 30;
			}
		} else if (state === 'feed') {
			const nf = nearestFood();
			if (nf && nf.dist > 20) {
				const foodAngle = Math.atan2(-(nf.item.y - fly.y), nf.item.x - fly.x);
				targetDir = foodAngle;
				targetSpeed = 0.25;
				speedChangeInterval = (targetSpeed - speed) / 30;
			} else {
				targetSpeed = 0;
				speedChangeInterval = -speed * 0.1;
			}
		} else if (state === 'brace') {
			targetSpeed = 0;
			speedChangeInterval = -speed * 0.1;
			const braceDir = normalizeAngle(BRAIN.stimulate.windDirection + Math.PI);
			const braceDiff = normalizeAngle(braceDir - targetDir);
			targetDir += braceDiff * 0.8;
			targetDir = normalizeAngle(targetDir);
		} else if (state === 'groom' || state === 'rest') {
			targetSpeed = 0;
			speedChangeInterval = -speed * 0.1;
		} else {
			targetSpeed = 0;
			speedChangeInterval = -speed * 0.05;
		}
	}

	function applyBehaviorMovement(dtScale) {
		if (behavior.current === 'startle') {
			const now = Date.now();
			if (behavior.startlePhase === 'freeze') {
				speed = 0;
				speedChangeInterval = 0;
				if (now >= behavior.startleFreezeEnd) {
					behavior.startlePhase = 'burst';
					speed = 3.0;
					behavior.burstDir = normalizeAngle(facingDir + Math.PI + (Math.random() - 0.5) * 0.5);
					targetDir = behavior.burstDir;
					facingDir = behavior.burstDir;
					targetSpeed = 0.5;
					speedChangeInterval = (targetSpeed - speed) / 30;
				}
			}
		}

		if (behavior.current === 'groom' ||
			behavior.current === 'rest' || behavior.current === 'idle' ||
			behavior.current === 'brace') {
			if (speed > 0.05) {
				speed *= Math.pow(0.92, dtScale);
			} else {
				speed = 0;
			}
		}
		if (behavior.current === 'feed') {
			const nf = nearestFood();
			if (nf && nf.dist > 20) {
				if (speed > 0.2) {
					speed *= Math.pow(0.92, dtScale);
				}
			} else {
				if (speed > 0.05) {
					speed *= Math.pow(0.92, dtScale);
				} else {
					speed = 0;
				}
			}
		}
	}

	/* ---- per-frame movement update (ported main.js update(dt)) ---- */

	function update(dt) {
		const dtScale = dt / (1000 / 60);
		applyBehaviorMovement(dtScale);

		speed += speedChangeInterval * dtScale;
		if (speed < 0) speed = 0;

		// Edge avoidance
		const edgeMargin = 50;
		let edgeBias = 0;
		let edgeBiasY = 0;

		if (fly.x < edgeMargin) {
			edgeBias += (edgeMargin - fly.x) / edgeMargin;
		} else if (WORLD.w - fly.x < edgeMargin) {
			edgeBias -= (edgeMargin - (WORLD.w - fly.x)) / edgeMargin;
		}
		if (fly.y < edgeMargin) {
			edgeBiasY -= (edgeMargin - fly.y) / edgeMargin;
		} else if (WORLD.h - fly.y < edgeMargin) {
			edgeBiasY += (edgeMargin - (WORLD.h - fly.y)) / edgeMargin;
		}

		if (edgeBias !== 0 || edgeBiasY !== 0) {
			const awayAngle = Math.atan2(edgeBiasY, edgeBias);
			const awayStrength = Math.min(1, Math.sqrt(edgeBias * edgeBias + edgeBiasY * edgeBiasY));
			const angleDiffEdge = normalizeAngle(awayAngle - targetDir);
			targetDir += angleDiffEdge * awayStrength * 0.3 * dtScale;
		}

		let turnRetention;
		if (behavior.current === 'startle' && behavior.startlePhase === 'burst') {
			turnRetention = 0.3;
		} else if (behavior.current === 'fly') {
			turnRetention = 0.4;
		} else {
			turnRetention = 0.9;
		}
		const angleDiffTurn = normalizeAngle(targetDir - facingDir);
		facingDir += angleDiffTurn * (1 - Math.pow(turnRetention, dtScale));

		facingDir = normalizeAngle(facingDir);
		targetDir = normalizeAngle(targetDir);

		fly.x += Math.cos(facingDir) * speed * dtScale;
		fly.y -= Math.sin(facingDir) * speed * dtScale;

		// World bounds -> touch stimulus (fly bumps the wall)
		if (fly.x < 0) {
			fly.x = 0;
			BRAIN.stimulate.touch = true;
			touchResetTime = Math.max(touchResetTime, Date.now() + 2000);
		} else if (fly.x > WORLD.w) {
			fly.x = WORLD.w;
			BRAIN.stimulate.touch = true;
			touchResetTime = Math.max(touchResetTime, Date.now() + 2000);
		}
		if (fly.y < 0) {
			fly.y = 0;
			BRAIN.stimulate.touch = true;
			touchResetTime = Math.max(touchResetTime, Date.now() + 2000);
		} else if (fly.y > WORLD.h) {
			fly.y = WORLD.h;
			BRAIN.stimulate.touch = true;
			touchResetTime = Math.max(touchResetTime, Date.now() + 2000);
		}

		// Food proximity + gradual feeding (mission mutation fires on consume)
		BRAIN.stimulate.foodContact = false;
		BRAIN.stimulate.foodNearby = false;
		for (let i = 0; i < food.length; i++) {
			const dist = Math.hypot(fly.x - food[i].x, fly.y - food[i].y);
			// Mission food carries a long-range odor plume so the fly can smell
			// a pending service node from across the board (upstream default 50).
			if (dist <= (food[i].odorRadius || 50)) {
				BRAIN.stimulate.foodNearby = true;
				if (dist <= 20) {
					BRAIN.stimulate.foodContact = true;
					if (behavior.current === 'feed') {
						if (food[i].feedStart === 0) {
							food[i].feedStart = Date.now();
							if (!food[i].feedDuration) food[i].feedDuration = 2000 + Math.random() * 3000;
						}
						const elapsed = Date.now() - food[i].feedStart;
						const progress = Math.min(1, (food[i].eaten || 0) + elapsed / food[i].feedDuration);
						food[i].radius = 10 * (1 - progress * 0.9);
						if (progress >= 1) {
							const eatenItem = food[i];
							food.splice(i, 1);
							i--;
							if (onFoodConsumed) {
								try {
									onFoodConsumed(eatenItem.stepId, eatenItem);
								} catch (err) {
									log('onFoodConsumed error: ' + (err && err.message));
								}
							}
						}
					} else {
						food[i].radius = 10 * (1 - (food[i].eaten || 0) * 0.9);
					}
				} else {
					if (food[i].feedStart !== 0) {
						const ate = Date.now() - food[i].feedStart;
						food[i].eaten = Math.min(1, (food[i].eaten || 0) + ate / food[i].feedDuration);
						food[i].feedStart = 0;
					}
					food[i].radius = 10 * (1 - (food[i].eaten || 0) * 0.9);
				}
			} else {
				if (food[i].feedStart !== 0) {
					const ate = Date.now() - food[i].feedStart;
					food[i].eaten = Math.min(1, (food[i].eaten || 0) + ate / food[i].feedDuration);
					food[i].feedStart = 0;
				}
				food[i].radius = 10 * (1 - (food[i].eaten || 0) * 0.9);
			}
		}

		if (touchResetTime > 0 && Date.now() >= touchResetTime) {
			BRAIN.stimulate.touch = false;
			BRAIN.stimulate.touchLocation = null;
			touchResetTime = 0;
		}
	}

	/* ---- brain tick (500ms, ported updateBrain minus DOM) ---- */

	function brainTick() {
		BRAIN.update();
		// Mission nudge: keep hunger high while a step's food is on the board
		if (hungerFloor > 0 && BRAIN.drives.hunger < hungerFloor) {
			BRAIN.drives.hunger = hungerFloor;
		}
		updateBehaviorState();
		computeMovementForBehavior();
	}

	/* ---- loops ---- */

	let brainTickTimer = null;
	let moveTimer = null;
	let lastMove = 0;

	function start() {
		if (brainTickTimer) return;
		brainTickTimer = setInterval(brainTick, 500);
		lastMove = Date.now();
		moveTimer = setInterval(function () {
			const now = Date.now();
			let dt = now - lastMove;
			lastMove = now;
			if (dt > 100) dt = 100;
			update(dt);
		}, 33);
	}

	function stop() {
		if (brainTickTimer) clearInterval(brainTickTimer);
		if (moveTimer) clearInterval(moveTimer);
		brainTickTimer = null;
		moveTimer = null;
	}

	return {
		world: WORLD,
		fly: fly,
		food: food,
		behavior: behavior,
		start: start,
		stop: stop,
		spawnFood: function (x, y, stepId) {
			food.push({
				x: x, y: y, radius: 10, eaten: 0, feedStart: 0, feedDuration: 0,
				stepId: stepId, odorRadius: 3000,
			});
		},
		clearFood: function (stepId) {
			for (let i = food.length - 1; i >= 0; i--) {
				if (stepId === undefined || food[i].stepId === stepId) food.splice(i, 1);
			}
		},
		setHungerFloor: function (v) { hungerFloor = v || 0; },
		setOnFoodConsumed: function (fn) { onFoodConsumed = fn; },
		triggerNociception: function () { BRAIN.stimulate.nociception = true; },
		celebrate: function () {
			// ALL GREEN: satiated + strong grooming urge -> victory grooming
			BRAIN.drives.groom = 1.0;
			BRAIN.drives.hunger = 0;
		},
		getFlyState: function () {
			return {
				x: Math.round(fly.x * 10) / 10,
				y: Math.round(fly.y * 10) / 10,
				facing: Math.round(facingDir * 1000) / 1000,
				behavior: behavior.current,
				startlePhase: behavior.startlePhase,
				speed: Math.round(speed * 100) / 100,
				drives: {
					hunger: Math.round(BRAIN.drives.hunger * 100) / 100,
					fear: Math.round(BRAIN.drives.fear * 100) / 100,
					fatigue: Math.round(BRAIN.drives.fatigue * 100) / 100,
					curiosity: Math.round(BRAIN.drives.curiosity * 100) / 100,
					groom: Math.round(BRAIN.drives.groom * 100) / 100,
				},
				food: food.map(function (f) {
					return { x: f.x, y: f.y, r: Math.round(f.radius * 10) / 10, stepId: f.stepId };
				}),
			};
		},
	};
}

module.exports = { createBehavior, WORLD };
