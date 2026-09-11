/* stream-client.js
 *
 * SSE subscriber + shared client state. Browsers are pure renderers: this
 * module keeps the latest streamed state (fly, mission, spikes, viewers),
 * interpolates fly position between ~15Hz server updates for smooth 60fps
 * rendering, and auto-reconnects (resync via the init snapshot the server
 * sends on every connect).
 */
(function () {
	'use strict';

	var STREAM = {
		connected: false,
		world: { w: 1600, h: 900 },
		brain: null,          // {neuronCount, edgeCount, groups, groupSizes, groupRegions}
		mission: null,        // mission snapshot, updated by deltas
		viewers: 0,
		config: { tokenConfigured: false, dryRun: true, adminRequired: false },
		spikes: null,         // latest {t, n, g}
		fly: null,            // latest raw fly event
		listeners: {},        // eventName -> [fn]
	};

	// interpolation buffer
	var prevFly = null;
	var lastFly = null;
	var lastFlyAt = 0;
	var flyIntervalMs = 66;

	STREAM.on = function (name, fn) {
		(STREAM.listeners[name] = STREAM.listeners[name] || []).push(fn);
	};
	function fire(name, data) {
		var fns = STREAM.listeners[name] || [];
		for (var i = 0; i < fns.length; i++) fns[i](data);
	}

	/**
	 * Returns the fly state interpolated between the last two server updates.
	 */
	STREAM.getFly = function () {
		if (!lastFly) return null;
		if (!prevFly) return lastFly;
		var t = Math.min(1.5, (performance.now() - lastFlyAt) / flyIntervalMs);
		var a = prevFly, b = lastFly;
		var dFacing = b.facing - a.facing;
		if (dFacing > Math.PI) dFacing -= 2 * Math.PI;
		if (dFacing < -Math.PI) dFacing += 2 * Math.PI;
		return {
			x: a.x + (b.x - a.x) * t,
			y: a.y + (b.y - a.y) * t,
			facing: a.facing + dFacing * t,
			behavior: b.behavior,
			startlePhase: b.startlePhase,
			speed: b.speed,
			drives: b.drives,
			food: b.food,
		};
	};

	function applyMissionDelta(evt) {
		var m = STREAM.mission;
		if (!m) return;
		switch (evt.kind) {
		case 'log':
			m.log.push({ ts: evt.ts, line: evt.line });
			if (m.log.length > 200) m.log.shift();
			break;
		case 'step':
			for (var i = 0; i < m.steps.length; i++) {
				if (m.steps[i].id === evt.stepId) {
					m.steps[i].state = evt.state;
					m.steps[i].retries = evt.retries;
				}
			}
			break;
		case 'mission-state':
			m.mission = evt.state;
			// Approximate; the next snapshot (reconnect) carries the exact value
			if (evt.state === 'ARMED') m.startedAt = Date.now();
			break;
		case 'services':
			m.serviceStatuses = evt.statuses;
			break;
		case 'project':
			m.projectId = evt.projectId;
			m.projectUrl = evt.projectUrl;
			break;
		case 'domain':
			m.webDomain = evt.domain;
			break;
		case 'stats':
			m.stats = evt.stats;
			break;
		}
		fire('mission', evt);
	}

	function connect() {
		var es = new EventSource('/api/stream');

		es.addEventListener('init', function (e) {
			var snap = JSON.parse(e.data);
			STREAM.world = snap.world;
			STREAM.brain = snap.brain;
			STREAM.mission = snap.mission;
			// Normalize server-epoch startedAt to this client's clock so the
			// run timer survives clock skew (delta handlers use client time)
			if (snap.now && STREAM.mission.startedAt) {
				STREAM.mission.startedAt = Date.now() - (snap.now - STREAM.mission.startedAt);
			}
			STREAM.viewers = snap.viewers;
			STREAM.config = snap.config;
			prevFly = null;
			lastFly = snap.fly;
			lastFlyAt = performance.now();
			STREAM.connected = true;
			fire('init', snap);
			fire('viewers', snap.viewers);
		});

		es.addEventListener('fly', function (e) {
			var now = performance.now();
			if (lastFly) flyIntervalMs = Math.max(30, Math.min(200, now - lastFlyAt));
			prevFly = lastFly;
			lastFly = JSON.parse(e.data);
			lastFlyAt = now;
			STREAM.fly = lastFly;
		});

		es.addEventListener('spikes', function (e) {
			STREAM.spikes = JSON.parse(e.data);
			fire('spikes', STREAM.spikes);
		});

		es.addEventListener('mission', function (e) {
			applyMissionDelta(JSON.parse(e.data));
		});

		es.addEventListener('viewers', function (e) {
			STREAM.viewers = JSON.parse(e.data).count;
			fire('viewers', STREAM.viewers);
		});

		es.onerror = function () {
			// EventSource auto-reconnects; init snapshot resyncs us on reopen
			STREAM.connected = false;
			fire('connection', false);
		};
		es.onopen = function () {
			STREAM.connected = true;
			fire('connection', true);
		};
	}

	connect();
	window.STREAM = STREAM;
})();
