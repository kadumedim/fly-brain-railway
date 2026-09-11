/* canvas-board.js
 *
 * Railway-style node-graph renderer + main render loop. Draws the dark
 * dotted-grid board, rounded service cards with status pills at each mission
 * node, bezier wiring edges (appear at wire-vars), the food, and the shared
 * fly (via FlySprite) from the interpolated SSE state.
 */
(function () {
	'use strict';

	var canvas = document.getElementById('board');
	var ctx = canvas.getContext('2d');
	var stage = document.getElementById('stage');

	var COLORS = {
		bg: '#0b0d11',
		grid: 'rgba(139, 147, 163, 0.13)',
		card: '#171b24',
		cardBorder: '#232a36',
		text: '#e6e9ef',
		muted: '#8b93a3',
		green: '#4ade80',
		yellow: '#fbbf24',
		red: '#f87171',
		gray: '#4b5563',
		accent: '#c084fc',
		food: '#fbc02d',
		edge: 'rgba(192, 132, 252, 0.5)',
	};

	var CARD_W = 200;
	var CARD_H = 74;

	var shakeUntil = {}; // stepId -> timestamp

	STREAM.on('mission', function (evt) {
		if (evt.kind === 'node-failed') {
			shakeUntil[evt.stepId] = Date.now() + 900;
		}
	});

	/* ---- sizing ---- */

	var viewScale = 1, offX = 0, offY = 0;
	var gridCanvas = null; // static dot grid, rendered once per resize

	function buildGrid() {
		var world = STREAM.world;
		var dpr = window.devicePixelRatio || 1;
		gridCanvas = document.createElement('canvas');
		gridCanvas.width = world.w * viewScale * dpr;
		gridCanvas.height = world.h * viewScale * dpr;
		var g = gridCanvas.getContext('2d');
		g.setTransform(viewScale * dpr, 0, 0, viewScale * dpr, 0, 0);
		g.fillStyle = COLORS.grid;
		var gap = 36;
		for (var x = gap / 2; x < world.w; x += gap) {
			for (var y = gap / 2; y < world.h; y += gap) {
				g.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
			}
		}
	}

	function resize() {
		var dpr = window.devicePixelRatio || 1;
		var w = stage.clientWidth;
		var h = stage.clientHeight;
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		canvas.style.width = w + 'px';
		canvas.style.height = h + 'px';
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		var world = STREAM.world;
		viewScale = Math.min(w / world.w, h / world.h);
		offX = (w - world.w * viewScale) / 2;
		offY = (h - world.h * viewScale) / 2;
		buildGrid();
	}
	window.addEventListener('resize', resize);
	STREAM.on('init', resize);

	/* ---- drawing helpers ---- */

	function roundRect(x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	function drawGrid() {
		if (!gridCanvas) return;
		var world = STREAM.world;
		// one blit instead of ~1,100 fillRects per frame
		ctx.drawImage(gridCanvas, 0, 0, world.w, world.h);
	}

	function stepVisual(step, statuses) {
		// -> {pill, pillColor, borderColor, pulse}
		var svcStatus = null;
		if (step.id === 'postgres' || step.id === 'redis' || step.id === 'web' || step.id === 'worker') {
			svcStatus = statuses[step.id] || null;
		}
		switch (step.state) {
		case 'LOCKED':
			return { pill: 'locked', color: COLORS.gray, pulse: false, dim: true };
		case 'AVAILABLE':
			return { pill: 'awaiting fly', color: COLORS.yellow, pulse: true };
		case 'EXECUTING':
			return { pill: 'mutating…', color: COLORS.yellow, pulse: true };
		case 'VERIFYING':
			return { pill: svcStatus && svcStatus !== 'NONE' ? svcStatus.toLowerCase() : 'deploying…', color: COLORS.yellow, pulse: true };
		case 'DONE':
			return { pill: svcStatus === 'SUCCESS' ? 'SUCCESS' : 'done', color: COLORS.green, pulse: false };
		case 'FAILED':
			return { pill: 'FAILED', color: COLORS.red, pulse: false };
		default:
			return { pill: step.state, color: COLORS.gray, pulse: false };
		}
	}

	var STEP_SUBTITLES = {
		'postgres': 'postgres:16-alpine',
		'redis': 'redis:7-alpine',
		'web': 'nginx:alpine + domain',
		'worker': 'alpine:3 · psql + redis-cli',
		'wire-vars': 'DATABASE_URL · REDIS_URL',
	};

	var STEP_ICONS = {
		'postgres': '🐘',
		'redis': '🟥',
		'web': '🌐',
		'worker': '🐝',
		'wire-vars': '🧵',
	};

	// The fly's own service: it lives in the same project it's building.
	var HOME_NODE = { x: 800, y: 150 };

	function drawHomeCard() {
		var x = HOME_NODE.x - CARD_W / 2;
		var y = HOME_NODE.y - CARD_H / 2;

		roundRect(x, y, CARD_W, CARD_H, 10);
		ctx.fillStyle = COLORS.card;
		ctx.fill();
		ctx.lineWidth = 1.5;
		ctx.strokeStyle = COLORS.accent;
		ctx.stroke();

		ctx.fillStyle = COLORS.text;
		ctx.font = '600 14px ui-sans-serif, system-ui';
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		ctx.fillText('🪰 fly-brain', x + 14, y + 22);

		ctx.fillStyle = COLORS.muted;
		ctx.font = '11px ui-monospace, monospace';
		ctx.fillText('this app — you are here', x + 14, y + 41);

		ctx.beginPath();
		ctx.arc(x + CARD_W - 16, y + 16, 4, 0, Math.PI * 2);
		ctx.fillStyle = COLORS.green;
		ctx.fill();
	}

	function drawCard(step, statuses, t) {
		var v = stepVisual(step, statuses);
		var x = step.node.x - CARD_W / 2;
		var y = step.node.y - CARD_H / 2;

		var shake = shakeUntil[step.id] && Date.now() < shakeUntil[step.id];
		if (shake) {
			x += Math.sin(Date.now() / 25) * 5;
		}

		ctx.save();
		if (v.dim) ctx.globalAlpha = 0.5;

		roundRect(x, y, CARD_W, CARD_H, 10);
		ctx.fillStyle = COLORS.card;
		ctx.fill();
		ctx.lineWidth = 1.5;
		var borderAlpha = v.pulse ? (0.55 + Math.sin(t / 250) * 0.4) : 1;
		ctx.strokeStyle = shake ? COLORS.red : v.color;
		ctx.globalAlpha = (v.dim ? 0.5 : 1) * Math.max(0.2, borderAlpha);
		ctx.stroke();
		ctx.globalAlpha = v.dim ? 0.5 : 1;

		// icon + title
		ctx.fillStyle = COLORS.text;
		ctx.font = '600 14px ui-sans-serif, system-ui';
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		ctx.fillText(STEP_ICONS[step.id] + ' ' + step.title, x + 14, y + 22);

		// subtitle -- streamed image is authoritative (WEB_IMAGE etc.)
		var subtitle = step.image || STEP_SUBTITLES[step.id] || '';
		if (step.id === 'worker' && step.image) subtitle = step.image + ' · psql + redis-cli';
		if (step.id === 'web' && step.image) subtitle = step.image + ' + domain';
		ctx.fillStyle = COLORS.muted;
		ctx.font = '11px ui-monospace, monospace';
		ctx.fillText(subtitle, x + 14, y + 41);

		// status pill
		var pillText = v.pill;
		ctx.font = '600 10px ui-sans-serif, system-ui';
		var tw = ctx.measureText(pillText).width;
		var px = x + 14, py = y + CARD_H - 18, ph = 15;
		roundRect(px, py - ph / 2, tw + 16, ph, ph / 2);
		ctx.fillStyle = 'rgba(0,0,0,0.35)';
		ctx.fill();
		ctx.strokeStyle = v.color;
		ctx.lineWidth = 1;
		ctx.globalAlpha = (v.dim ? 0.5 : 1) * (v.pulse ? Math.max(0.35, borderAlpha) : 1);
		ctx.stroke();
		ctx.globalAlpha = v.dim ? 0.5 : 1;
		ctx.fillStyle = v.color;
		ctx.fillText(pillText, px + 8, py + 0.5);

		// status dot
		ctx.beginPath();
		ctx.arc(x + CARD_W - 16, y + 16, 4, 0, Math.PI * 2);
		ctx.fillStyle = v.color;
		if (v.pulse) ctx.globalAlpha = (v.dim ? 0.5 : 1) * Math.max(0.25, borderAlpha);
		ctx.fill();

		if (step.retries > 0 && step.state !== 'DONE') {
			ctx.globalAlpha = 1;
			ctx.fillStyle = COLORS.red;
			ctx.font = '10px ui-sans-serif, system-ui';
			ctx.textAlign = 'right';
			ctx.fillText('retry ' + step.retries + '/3', x + CARD_W - 12, y + CARD_H - 17);
		}

		ctx.restore();
	}

	function drawEdges(steps) {
		// Wiring edges appear once wire-vars starts executing
		var wire = null, worker = null, pg = null, redis = null;
		for (var i = 0; i < steps.length; i++) {
			if (steps[i].id === 'wire-vars') wire = steps[i];
			if (steps[i].id === 'worker') worker = steps[i];
			if (steps[i].id === 'postgres') pg = steps[i];
			if (steps[i].id === 'redis') redis = steps[i];
		}
		if (!wire || wire.state === 'LOCKED' || wire.state === 'AVAILABLE') return;

		function edge(a, b) {
			var mx = (a.node.x + b.node.x) / 2;
			ctx.beginPath();
			ctx.moveTo(a.node.x, a.node.y + CARD_H / 2);
			ctx.bezierCurveTo(a.node.x, a.node.y + 90, mx, b.node.y + 90, b.node.x, b.node.y + CARD_H / 2);
			ctx.strokeStyle = COLORS.edge;
			ctx.lineWidth = 1.5;
			ctx.setLineDash(wire.state === 'DONE' ? [] : [6, 6]);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		if (worker && pg) edge(worker, pg);
		if (worker && redis) edge(worker, redis);
	}

	function drawFood(foodList, flyState, t) {
		if (!foodList) return;
		for (var i = 0; i < foodList.length; i++) {
			var f = foodList[i];
			var distToFly = flyState ? Math.hypot(flyState.x - f.x, flyState.y - f.y) : 1e9;
			if (distToFly <= 50) {
				var pulse = 0.3 + Math.sin(t / 200) * 0.15;
				ctx.beginPath();
				ctx.arc(f.x, f.y, f.r + 6, 0, Math.PI * 2);
				ctx.fillStyle = 'rgba(251, 192, 45, ' + pulse.toFixed(2) + ')';
				ctx.fill();
			}
			ctx.beginPath();
			ctx.arc(f.x, f.y, Math.max(1, f.r), 0, Math.PI * 2);
			ctx.fillStyle = COLORS.food;
			ctx.fill();
			// soft odor ring
			ctx.beginPath();
			ctx.arc(f.x, f.y, f.r + 14 + Math.sin(t / 400) * 4, 0, Math.PI * 2);
			ctx.strokeStyle = 'rgba(251, 192, 45, 0.18)';
			ctx.lineWidth = 1;
			ctx.stroke();
		}
	}

	function drawBehaviorLabel(flyState) {
		var label = flyState.behavior;
		if (label === 'idle') return;
		ctx.font = '11px ui-monospace, monospace';
		ctx.fillStyle = 'rgba(230, 233, 239, 0.55)';
		ctx.textAlign = 'center';
		ctx.fillText(label, flyState.x, flyState.y + 42);
	}

	/* ---- main loop ---- */

	var lastFrame = performance.now();

	function frame(now) {
		var dt = now - lastFrame;
		lastFrame = now;
		if (dt > 100) dt = 100;
		var dtScale = dt / (1000 / 60);

		var w = stage.clientWidth, h = stage.clientHeight;
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = COLORS.bg;
		ctx.fillRect(0, 0, w, h);

		if (STREAM.mission) {
			ctx.save();
			ctx.translate(offX, offY);
			ctx.scale(viewScale, viewScale);

			var t = Date.now();
			drawGrid();

			var steps = STREAM.mission.steps;
			drawHomeCard();
			drawEdges(steps);
			for (var i = 0; i < steps.length; i++) {
				drawCard(steps[i], STREAM.mission.serviceStatuses || {}, t);
			}

			var flyState = STREAM.getFly();
			drawFood(flyState && flyState.food, flyState, t);

			if (flyState) {
				ctx.save();
				ctx.translate(flyState.x, flyState.y);
				FlySprite.draw(ctx, flyState, dtScale);
				ctx.restore();
				drawBehaviorLabel(flyState);
			}

			ctx.restore();
		}

		requestAnimationFrame(frame);
	}

	resize();
	requestAnimationFrame(frame);
})();
