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
		parentPort.postMessage(msg);
	},
};

require('../vendor-sim/sim-worker.js');

parentPort.on('message', function (msg) {
	if (global.self.onmessage) {
		global.self.onmessage({ data: msg });
	}
});
