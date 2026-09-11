/* neural-panel.js
 *
 * Collapsible live spike raster. Renders streamed per-group fired counts
 * (10Hz `spikes` events, one Uint16 per neuron group) as a scrolling raster:
 * one row per group, ordered by region (sensory / central / drives / motor),
 * brightness proportional to the group's fired fraction. Visually equivalent
 * to flybrain's full raster at 1/100th the bandwidth.
 *
 * Spike history accumulates in a ring buffer whether or not the panel is
 * open, so collapsing and reopening (or resizing) repaints the full recent
 * raster instead of starting from a blank canvas.
 */
(function () {
	'use strict';

	var panel = document.getElementById('neuralPanel');
	var toggle = document.getElementById('neuralToggle');
	var canvas = document.getElementById('spikeCanvas');
	var ctx = canvas.getContext('2d');

	var REGION_ORDER = ['sensory', 'central', 'drives', 'motor'];
	var REGION_COLORS = {
		sensory: [96, 205, 255],   // cyan
		central: [192, 132, 252],  // purple
		drives: [251, 146, 60],    // orange
		motor: [74, 222, 128],     // green
	};

	var H = 140;
	var LABEL_W = 64;
	var COL_W = 2;
	var HISTORY_MAX = 1024; // ~100s at 10Hz; more than any panel width shows

	var rows = null;    // [{groupIdx, region}] in display order
	var sized = false;
	var history = [];   // ring of per-tick group-count arrays, newest last

	toggle.addEventListener('click', function () {
		panel.classList.toggle('collapsed');
		if (!panel.classList.contains('collapsed')) sized = false;
	});

	window.addEventListener('resize', function () { sized = false; });

	function buildRows() {
		var brain = STREAM.brain;
		if (!brain) return;
		rows = [];
		for (var r = 0; r < REGION_ORDER.length; r++) {
			for (var g = 0; g < brain.groups.length; g++) {
				if (brain.groupRegions[g] === REGION_ORDER[r] && brain.groupSizes[g] > 0) {
					rows.push({ groupIdx: g, region: REGION_ORDER[r] });
				}
			}
		}
		toggle.firstChild.nodeValue = '🧠 ' + brain.neuronCount.toLocaleString() +
			' neurons — live spikes ';
	}

	function drawColumn(x, counts) {
		var rowH = H / rows.length;
		var sizes = STREAM.brain.groupSizes;
		ctx.fillStyle = '#0b0d11';
		ctx.fillRect(x, 0, COL_W, H);
		for (var i = 0; i < rows.length; i++) {
			var g = rows[i].groupIdx;
			var frac = (counts[g] || 0) / sizes[g];
			if (frac <= 0) continue;
			var c = REGION_COLORS[rows[i].region];
			var a = Math.min(1, 0.15 + Math.pow(frac, 0.4) * 2);
			ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(2) + ')';
			ctx.fillRect(x, i * rowH, COL_W, Math.max(1, rowH - 0.5));
		}
	}

	function drawLabels() {
		var rowH = H / rows.length;
		ctx.fillStyle = '#0b0d11';
		ctx.fillRect(0, 0, LABEL_W, H);
		ctx.font = '9px ui-monospace, monospace';
		ctx.textBaseline = 'top';
		var lastRegion = null;
		for (var j = 0; j < rows.length; j++) {
			if (rows[j].region !== lastRegion) {
				lastRegion = rows[j].region;
				var col = REGION_COLORS[lastRegion];
				ctx.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')';
				ctx.fillText(lastRegion, 6, j * rowH + 1);
			}
		}
	}

	// Full repaint from the history buffer (reopen / resize / first draw)
	function redrawAll() {
		var dpr = window.devicePixelRatio || 1;
		var w = panel.clientWidth;
		canvas.width = w * dpr;
		canvas.height = H * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#0b0d11';
		ctx.fillRect(0, 0, w, H);

		var cols = Math.floor((w - LABEL_W) / COL_W);
		var n = Math.min(cols, history.length);
		for (var k = 0; k < n; k++) {
			drawColumn(w - (n - k) * COL_W, history[history.length - n + k]);
		}
		drawLabels();
		sized = true;
	}

	STREAM.on('init', function () {
		buildRows();
		sized = false;
	});

	STREAM.on('spikes', function (spikes) {
		if (!rows) buildRows();
		if (!rows) return;

		// History accumulates even while the panel is collapsed
		history.push(spikes.g);
		if (history.length > HISTORY_MAX) history.shift();

		if (panel.classList.contains('collapsed')) return;
		if (!sized) { redrawAll(); return; }

		// incremental: scroll the plot area left, draw the newest column
		var dpr = window.devicePixelRatio || 1;
		var w = panel.clientWidth;
		var plotW = w - LABEL_W;
		ctx.drawImage(canvas,
			(LABEL_W + COL_W) * dpr, 0, (plotW - COL_W) * dpr, H * dpr,
			LABEL_W, 0, plotW - COL_W, H);
		drawColumn(w - COL_W, spikes.g);
		drawLabels();
	});
})();
