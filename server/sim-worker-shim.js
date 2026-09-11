/* sim-worker-shim.js
 *
 * Runs the vendored browser Web Worker (vendor-sim/sim-worker.js, unmodified)
 * inside a Node worker_thread by mapping self.onmessage/postMessage onto
 * parentPort. DecompressionStream and performance are Node globals (>=18).
 */
'use strict';

const { parentPort } = require('node:worker_threads');

global.self = {
	onmessage: null,
	postMessage: function (msg) {
		// The host consumes only the 63-entry groupSpikeCounts; the full
		// 139KB per-neuron fireState would otherwise be structured-cloned
		// 10x/sec (~1.4MB/s of copy + GC churn) with zero consumers.
		if (msg && msg.type === 'tick' && msg.fireState) {
			msg = {
				type: 'tick',
				firedNeurons: msg.firedNeurons,
				groupSpikeCounts: msg.groupSpikeCounts,
				tickCount: msg.tickCount,
			};
		}
		parentPort.postMessage(msg);
	},
};

require('../vendor-sim/sim-worker.js');

parentPort.on('message', function (msg) {
	if (global.self.onmessage) {
		global.self.onmessage({ data: msg });
	}
});
