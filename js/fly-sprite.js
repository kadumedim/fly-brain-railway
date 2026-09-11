/* fly-sprite.js
 *
 * Animated fly drawing, ported from flybrain main.js. Pure renderer: driven
 * entirely by streamed `fly` events (behavior state, facing, speed). All
 * animation phases (walk cycle, wing spread, proboscis, groom rub, idle
 * jitter) are advanced client-side per frame.
 *
 * Usage: FlySprite.draw(ctx, flyState, dtScale) with ctx already translated
 * to the fly position (world coords) -- it applies rotation itself.
 */
(function () {
	'use strict';

	function normalizeAngle(a) {
		a = a % (2 * Math.PI);
		if (a > Math.PI) a -= 2 * Math.PI;
		if (a < -Math.PI) a += 2 * Math.PI;
		return a;
	}

	var anim = {
		walkPhase: 0,
		antennaTwitchL: 0, antennaTwitchR: 0,
		antennaTargetL: 0, antennaTargetR: 0,
		antennaTimer: 0,
		legJitter: [0, 0, 0, 0, 0, 0],
		legJitterTarget: [0, 0, 0, 0, 0, 0],
		legJitterTimer: 0,
		wingMicro: 0, wingMicroTarget: 0, wingMicroTimer: 0,
		antennaNextInterval: 0.8 + Math.random() * 1.2,
		legJitterNextInterval: 1.5 + Math.random() * 2.0,
		wingMicroNextInterval: 2.0 + Math.random() * 3.0,
		groomPhase: 0,
		proboscisExtend: 0,
		wingSpread: 0,
	};

	var BODY = {
		scale: 1.0,
		headRadius: 6, headOffsetY: -24,
		eyeRadiusX: 4, eyeRadiusY: 5, eyeOffsetX: 5.5, eyeOffsetY: -25,
		antennaBaseX: 2.5, antennaBaseY: -29, antennaLength: 10, antennaBulbRadius: 1.5,
		thoraxRadiusX: 8, thoraxRadiusY: 12, thoraxOffsetY: -10,
		abdomenRadiusX: 10, abdomenRadiusY: 16, abdomenOffsetY: 12,
		wingOffsetX: 7, wingOffsetY: -8, wingLength: 42, wingWidth: 16,
		proboscisLength: 8, proboscisBaseY: -30,
		legAttach: [{ x: 7, y: -16 }, { x: 9, y: -10 }, { x: 8, y: -3 }],
		legSeg1: 8, legSeg2: 10, legSeg3: 6,
		legRestAngles: [
			{ hip: -0.7, knee: -0.3 },
			{ hip: 0.0, knee: 0.2 },
			{ hip: 0.7, knee: 0.3 },
		],
	};

	var COLORS = {
		thorax: '#8B6914', thoraxStroke: '#6B4F10',
		abdomen: '#B8860B', abdomenStripe: '#9A7209', abdomenLight: '#C9972E',
		head: '#8B6914', headStroke: '#6B4F10',
		eyeFill: '#8B0000', eyeHighlight: '#CC2222',
		antenna: '#5C4A1E', antennaBulb: '#7A6428',
		leg: '#3D2B0F', legJoint: '#4A3412',
		proboscis: '#5C4A1E',
	};

	/** Advance animation phases from the streamed behavior state. */
	function updateAnim(state, speed, dtScale) {
		var targetWingSpread = 0;
		if (state === 'fly' || state === 'startle-burst') targetWingSpread = 1;
		anim.wingSpread += (targetWingSpread - anim.wingSpread) * (1 - Math.pow(0.85, dtScale));

		var targetProboscis = state === 'feed' ? 1 : 0;
		anim.proboscisExtend += (targetProboscis - anim.proboscisExtend) * (1 - Math.pow(0.9, dtScale));

		if (state === 'groom') anim.groomPhase += 0.12 * dtScale;

		if (state === 'walk' || state === 'explore' || state === 'phototaxis') {
			anim.walkPhase += Math.abs(speed) * 0.5 * dtScale;
		}
	}

	function drawWing(ctx, side) {
		var wx = BODY.wingOffsetX * side;
		var wy = BODY.wingOffsetY;
		var wl = BODY.wingLength;
		var ww = BODY.wingWidth * side;
		var microOffset = anim.wingMicro * 0.5 * side;
		var spreadAngle = anim.wingSpread * 0.85;
		var buzzOffset = 0;
		if (anim.wingSpread > 0.5) {
			buzzOffset = Math.sin(Date.now() / 30) * 0.15 * anim.wingSpread;
		}

		ctx.save();
		ctx.translate(wx + microOffset, wy);
		ctx.rotate(side * (0.35 + spreadAngle) + microOffset * 0.02 + buzzOffset);
		var wingScale = 1.0 + anim.wingSpread * 0.3;
		ctx.scale(wingScale, wingScale);
		var wingAlpha = 0.3 + anim.wingSpread * 0.35;

		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.bezierCurveTo(ww * 1.2, wl * 0.2, ww * 1.4, wl * 0.7, ww * 0.3, wl);
		ctx.bezierCurveTo(-ww * 0.2, wl * 0.8, -ww * 0.1, wl * 0.3, 0, 0);
		ctx.fillStyle = 'rgba(200, 210, 230, ' + wingAlpha.toFixed(2) + ')';
		ctx.fill();
		ctx.strokeStyle = 'rgba(180, 190, 210, ' + Math.min(1, wingAlpha + 0.2).toFixed(2) + ')';
		ctx.lineWidth = 0.5;
		ctx.stroke();

		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(ww * 0.5, wl * 0.8);
		ctx.moveTo(0, 2);
		ctx.lineTo(ww * 1.0, wl * 0.5);
		ctx.moveTo(0, 1);
		ctx.lineTo(ww * 0.8, wl * 0.3);
		ctx.strokeStyle = 'rgba(160, 170, 190, ' + Math.min(1, wingAlpha + 0.1).toFixed(2) + ')';
		ctx.lineWidth = 0.3;
		ctx.stroke();

		ctx.restore();
	}

	function drawAbdomen(ctx, state) {
		var ax = 0;
		var ay = BODY.abdomenOffsetY;
		var rx = BODY.abdomenRadiusX;
		var ry = BODY.abdomenRadiusY;

		if (state === 'groom') {
			ay += Math.sin(anim.groomPhase * 0.8) * 2;
		}

		ctx.beginPath();
		ctx.ellipse(ax, ay, rx, ry, 0, 0, Math.PI * 2);
		ctx.fillStyle = COLORS.abdomen;
		ctx.fill();

		ctx.save();
		ctx.beginPath();
		ctx.ellipse(ax, ay, rx, ry, 0, 0, Math.PI * 2);
		ctx.clip();
		for (var s = 0; s < 4; s++) {
			var stripeY = ay - ry * 0.3 + s * (ry * 0.45);
			ctx.beginPath();
			ctx.ellipse(ax, stripeY, rx * 1.1, ry * 0.08, 0, 0, Math.PI * 2);
			ctx.fillStyle = COLORS.abdomenStripe;
			ctx.fill();
		}
		ctx.beginPath();
		ctx.ellipse(ax, ay - 2, rx * 0.3, ry * 0.85, 0, 0, Math.PI * 2);
		ctx.fillStyle = COLORS.abdomenLight;
		ctx.globalAlpha = 0.15;
		ctx.fill();
		ctx.globalAlpha = 1.0;
		ctx.restore();
	}

	function drawThorax(ctx) {
		ctx.beginPath();
		ctx.ellipse(0, BODY.thoraxOffsetY, BODY.thoraxRadiusX, BODY.thoraxRadiusY, 0, 0, Math.PI * 2);
		ctx.fillStyle = COLORS.thorax;
		ctx.fill();
		ctx.strokeStyle = COLORS.thoraxStroke;
		ctx.lineWidth = 0.8;
		ctx.stroke();

		ctx.beginPath();
		ctx.moveTo(0, BODY.thoraxOffsetY - BODY.thoraxRadiusY * 0.7);
		ctx.lineTo(0, BODY.thoraxOffsetY + BODY.thoraxRadiusY * 0.7);
		ctx.strokeStyle = COLORS.thoraxStroke;
		ctx.lineWidth = 0.5;
		ctx.globalAlpha = 0.3;
		ctx.stroke();
		ctx.globalAlpha = 1.0;
	}

	function drawHead(ctx) {
		ctx.beginPath();
		ctx.ellipse(0, BODY.headOffsetY, BODY.headRadius * 1.1, BODY.headRadius, 0, 0, Math.PI * 2);
		ctx.fillStyle = COLORS.head;
		ctx.fill();
		ctx.strokeStyle = COLORS.headStroke;
		ctx.lineWidth = 0.6;
		ctx.stroke();
	}

	function drawEyes(ctx) {
		for (var side = -1; side <= 1; side += 2) {
			var ex = BODY.eyeOffsetX * side;
			var ey = BODY.eyeOffsetY;
			ctx.beginPath();
			ctx.ellipse(ex, ey, BODY.eyeRadiusX, BODY.eyeRadiusY, side * 0.3, 0, Math.PI * 2);
			ctx.fillStyle = COLORS.eyeFill;
			ctx.fill();
			ctx.beginPath();
			ctx.ellipse(ex - side * 1, ey - 1.5, BODY.eyeRadiusX * 0.4, BODY.eyeRadiusY * 0.35, side * 0.3, 0, Math.PI * 2);
			ctx.fillStyle = COLORS.eyeHighlight;
			ctx.globalAlpha = 0.5;
			ctx.fill();
			ctx.globalAlpha = 1.0;
		}
	}

	function drawAntennae(ctx, t, dtScale) {
		if (t - anim.antennaTimer > anim.antennaNextInterval) {
			anim.antennaTimer = t;
			anim.antennaNextInterval = 0.8 + Math.random() * 1.2;
			anim.antennaTargetL = (Math.random() - 0.5) * 0.4;
			anim.antennaTargetR = (Math.random() - 0.5) * 0.4;
		}
		anim.antennaTwitchL += (anim.antennaTargetL - anim.antennaTwitchL) * (1 - Math.pow(0.92, dtScale));
		anim.antennaTwitchR += (anim.antennaTargetR - anim.antennaTwitchR) * (1 - Math.pow(0.92, dtScale));

		for (var side = -1; side <= 1; side += 2) {
			var bx = BODY.antennaBaseX * side;
			var by = BODY.antennaBaseY;
			var twitch = side === -1 ? anim.antennaTwitchL : anim.antennaTwitchR;
			var baseAngle = -Math.PI / 2 + side * 0.5 + twitch;
			var tipX = bx + Math.cos(baseAngle) * BODY.antennaLength;
			var tipY = by + Math.sin(baseAngle) * BODY.antennaLength;

			ctx.beginPath();
			ctx.moveTo(bx, by);
			var cpx = bx + Math.cos(baseAngle) * BODY.antennaLength * 0.5 + side * 1;
			var cpy = by + Math.sin(baseAngle) * BODY.antennaLength * 0.5 - 1;
			ctx.quadraticCurveTo(cpx, cpy, tipX, tipY);
			ctx.strokeStyle = COLORS.antenna;
			ctx.lineWidth = 1.0;
			ctx.stroke();

			ctx.beginPath();
			ctx.arc(tipX, tipY, BODY.antennaBulbRadius, 0, Math.PI * 2);
			ctx.fillStyle = COLORS.antennaBulb;
			ctx.fill();
		}
	}

	function drawProboscis(ctx, extend) {
		var len = BODY.proboscisLength * extend;
		ctx.beginPath();
		ctx.moveTo(0, BODY.proboscisBaseY);
		ctx.lineTo(0, BODY.proboscisBaseY - len);
		ctx.strokeStyle = COLORS.proboscis;
		ctx.lineWidth = 1.2;
		ctx.lineCap = 'round';
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(0, BODY.proboscisBaseY - len, 1, 0, Math.PI * 2);
		ctx.fillStyle = COLORS.proboscis;
		ctx.fill();
	}

	function drawLegs(ctx, state, dtScale) {
		var t = Date.now() / 1000;
		var isWalking = (state === 'walk' || state === 'explore' || state === 'phototaxis');
		var isGrooming = (state === 'groom');
		var isFlying = (state === 'fly');
		var isStartleBurst = (state === 'startle-burst');
		var isStartleFreeze = (state === 'startle-freeze');
		var isResting = (state === 'rest');
		var isBracing = (state === 'brace');

		if (t - anim.legJitterTimer > anim.legJitterNextInterval) {
			anim.legJitterTimer = t;
			anim.legJitterNextInterval = 1.5 + Math.random() * 2.0;
			for (var j = 0; j < 6; j++) {
				anim.legJitterTarget[j] = (Math.random() - 0.5) * 0.15;
			}
		}
		for (var j2 = 0; j2 < 6; j2++) {
			anim.legJitter[j2] += (anim.legJitterTarget[j2] - anim.legJitter[j2]) * (1 - Math.pow(0.95, dtScale));
		}

		if (t - anim.wingMicroTimer > anim.wingMicroNextInterval) {
			anim.wingMicroTimer = t;
			anim.wingMicroNextInterval = 2.0 + Math.random() * 3.0;
			anim.wingMicroTarget = (Math.random() - 0.5) * 2;
		}
		anim.wingMicro += (anim.wingMicroTarget - anim.wingMicro) * (1 - Math.pow(0.97, dtScale));

		var groupA = [0, 3, 4];

		for (var legIdx = 0; legIdx < 6; legIdx++) {
			var pairIdx = Math.floor(legIdx / 2);
			var side = (legIdx % 2 === 0) ? -1 : 1;
			var attach = BODY.legAttach[pairIdx];
			var restAngles = BODY.legRestAngles[pairIdx];

			var hipMod = restAngles.hip;
			var kneeMod = restAngles.knee;
			var walkOffset = 0;
			var jitter = 0;

			if (isWalking) {
				var inGroupA = groupA.indexOf(legIdx) !== -1;
				var legPhase = anim.walkPhase + (inGroupA ? 0 : Math.PI);
				walkOffset = Math.sin(legPhase) * 0.35;
			} else if (isGrooming) {
				// Grooming rub with front legs (thorax groom is the default)
				if (pairIdx === 0) {
					hipMod = -0.2 + Math.sin(anim.groomPhase) * 0.5;
					kneeMod = -0.6 + Math.sin(anim.groomPhase * 1.3) * 0.2;
				}
			} else if (isFlying) {
				hipMod *= 0.4;
				kneeMod *= 0.3;
			} else if (isStartleBurst && pairIdx >= 1) {
				hipMod *= 1.5;
				kneeMod *= 0.5;
			} else if (isStartleFreeze) {
				// frozen: rest angles as-is
			} else if (isResting) {
				hipMod *= 0.7;
				jitter = anim.legJitter[legIdx] * 0.3;
			} else if (isBracing) {
				hipMod *= 1.1;
				jitter = anim.legJitter[legIdx] * 0.1;
			} else {
				jitter = anim.legJitter[legIdx];
			}

			var hipAngle = (hipMod + walkOffset + jitter) * side;
			var kneeAngle = kneeMod * side;
			var ax = attach.x * side;
			var ay = attach.y;

			var baseAngle = (side === -1 ? Math.PI : 0) + hipAngle;
			var seg1EndX = ax + Math.cos(baseAngle) * BODY.legSeg1;
			var seg1EndY = ay + Math.sin(baseAngle) * BODY.legSeg1;
			var kneeAngleAbs = baseAngle + kneeAngle + side * 0.5;
			var seg2EndX = seg1EndX + Math.cos(kneeAngleAbs) * BODY.legSeg2;
			var seg2EndY = seg1EndY + Math.sin(kneeAngleAbs) * BODY.legSeg2;
			var tarsusAngle = kneeAngleAbs + side * 0.3;
			var seg3EndX = seg2EndX + Math.cos(tarsusAngle) * BODY.legSeg3;
			var seg3EndY = seg2EndY + Math.sin(tarsusAngle) * BODY.legSeg3;

			ctx.beginPath();
			ctx.moveTo(ax, ay);
			ctx.lineTo(seg1EndX, seg1EndY);
			ctx.lineTo(seg2EndX, seg2EndY);
			ctx.lineTo(seg3EndX, seg3EndY);
			ctx.strokeStyle = COLORS.leg;
			ctx.lineWidth = 1.4;
			ctx.lineJoin = 'round';
			ctx.lineCap = 'round';
			ctx.stroke();

			ctx.beginPath();
			ctx.arc(seg1EndX, seg1EndY, 1.2, 0, Math.PI * 2);
			ctx.fillStyle = COLORS.legJoint;
			ctx.fill();
			ctx.beginPath();
			ctx.arc(seg2EndX, seg2EndY, 1.0, 0, Math.PI * 2);
			ctx.fillStyle = COLORS.legJoint;
			ctx.fill();
		}
	}

	/**
	 * Draws the fly. flyState: streamed {facing, behavior, startlePhase, speed}.
	 * ctx must already be translated to the fly's world position.
	 */
	function draw(ctx, flyState, dtScale) {
		var state = flyState.behavior;
		if (state === 'startle') {
			state = flyState.startlePhase === 'burst' ? 'startle-burst' : 'startle-freeze';
		}
		updateAnim(state, flyState.speed || 0, dtScale);

		ctx.save();
		ctx.rotate(-flyState.facing + Math.PI / 2);
		ctx.scale(BODY.scale, BODY.scale);

		var t = Date.now() / 1000;
		drawLegs(ctx, state, dtScale);
		drawAbdomen(ctx, state);
		drawWing(ctx, -1);
		drawWing(ctx, 1);
		drawThorax(ctx);
		drawHead(ctx);
		drawEyes(ctx);
		drawAntennae(ctx, t, dtScale);
		if (anim.proboscisExtend > 0.01) {
			drawProboscis(ctx, anim.proboscisExtend);
		}
		ctx.restore();
	}

	window.FlySprite = { draw: draw, normalizeAngle: normalizeAngle };
})();
