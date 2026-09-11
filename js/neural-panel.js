/* neural-panel.js
 *
 * Collapsible live spike raster. Renders streamed per-group fired counts
 * (10Hz `spikes` events, one Uint16 per neuron group) as a scrolling raster:
 * one row per group, ordered by region (sensory / central / drives / motor),
 * brightness proportional to the group's fired fraction. Visually equivalent
 * to flybrain's full raster at 1/100th the bandwidth.
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

	var rows = null; // [{groupIdx, region}] in display order
	var sized = false;

	toggle.addEventListener('click', function () {
		panel.classList.toggle('collapsed');
		if (!panel.classList.contains('collapsed')) sized = false;
	});

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

	function ensureSize() {
		if (sized) return;
		var dpr = window.devicePixelRatio || 1;
		var w = panel.clientWidth;
		var h = 140;
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#0b0d11';
		ctx.fillRect(0, 0, w, h);
		sized = true;
	}

	STREAM.on('init', function () {
		buildRows();
		sized = false;
	});

	STREAM.on('spikes', function (spikes) {
		if (panel.classList.contains('collapsed')) return;
		if (!rows) buildRows();
		if (!rows) return;
		ensureSize();

		var w = panel.clientWidth;
		var h = 140;
		var labelW = 64;
		var plotW = w - labelW;
		var colW = 2;
		var rowH = h / rows.length;

		// scroll plot area left
		var dpr = window.devicePixelRatio || 1;
		ctx.drawImage(canvas,
			(labelW + colW) * dpr, 0, plotW * dpr - colW * dpr, h * dpr,
			labelW, 0, plotW - colW, h);

		// new column
		ctx.fillStyle = '#0b0d11';
		ctx.fillRect(w - colW, 0, colW, h);
		var sizes = STREAM.brain.groupSizes;
		for (var i = 0; i < rows.length; i++) {
			var g = rows[i].groupIdx;
			var frac = (spikes.g[g] || 0) / sizes[g];
			if (frac <= 0) continue;
			var c = REGION_COLORS[rows[i].region];
			var a = Math.min(1, 0.15 + Math.pow(frac, 0.4) * 2);
			ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(2) + ')';
			ctx.fillRect(w - colW, i * rowH, colW, Math.max(1, rowH - 0.5));
		}

		// region labels (repainted every tick over a cleared strip)
		ctx.fillStyle = '#0b0d11';
		ctx.fillRect(0, 0, labelW, h);
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
	});
})();
