/* server/index.js
 *
 * Zero-dependency Node 22 server: static files + REST + SSE fan-out.
 * Runs the single authoritative fly (brain worker_thread + behavior loop);
 * browsers are pure renderers on the SSE stream. Spectators are read-only;
 * all POSTs are gated by ADMIN_PASSWORD when set.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createBrainHost } = require('./brain-host.js');
const { createBehavior } = require('./behavior.js');
const { createRailwayClient } = require('./railway-client.js');
const { createPoller } = require('./poller.js');
const { createMission } = require('./mission.js');

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.join(__dirname, '..');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function log(line) {
	console.log('[' + new Date().toISOString() + '] ' + line);
}

/* ---------- SSE hub ---------- */

const sseClients = new Set();
let sseEventId = 0;

function sseWrite(res, event, data, id) {
	try {
		res.write((id !== undefined ? 'id: ' + id + '\n' : '') +
			'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
	} catch (e) { /* dead socket; cleanup happens on close */ }
}

function broadcast(event, data) {
	if (sseClients.size === 0) return;
	sseEventId++;
	const payload = 'id: ' + sseEventId + '\nevent: ' + event +
		'\ndata: ' + JSON.stringify(data) + '\n\n';
	for (const res of sseClients) {
		try { res.write(payload); } catch (e) { /* ignore */ }
	}
}

setInterval(function () {
	for (const res of sseClients) {
		try { res.write(': ka\n\n'); } catch (e) { /* ignore */ }
	}
}, 15000);

/* ---------- brain + behavior + mission ---------- */

let latestSpikeTick = null;

const host = createBrainHost({
	log: log,
	onSpikeTick: function (groupSpikeCounts, firedNeurons, tickCount) {
		latestSpikeTick = tickCount;
		broadcast('spikes', {
			t: tickCount,
			n: firedNeurons,
			g: Array.from(groupSpikeCounts),
		});
	},
});

const behavior = createBehavior(host, { log: log });
const client = createRailwayClient({ log: log });
const poller = createPoller(client, { log: log });
const mission = createMission({
	behavior: behavior,
	client: client,
	poller: poller,
	log: log,
	emit: function (evt) { broadcast('mission', evt); },
});

host.ready.then(function () {
	log('Brain online: ' + host.neuronCount + ' neurons / ' + host.edgeCount + ' edges (FlyWire FAFB v783)');
	behavior.start();
	mission.kickLoop();
	// fly state at ~15Hz
	setInterval(function () {
		broadcast('fly', behavior.getFlyState());
	}, 66);
}).catch(function (err) {
	console.error('FATAL: brain failed to start:', err);
	process.exit(1);
});

/* ---------- helpers ---------- */

function isAdmin(req) {
	if (!ADMIN_PASSWORD) return true;
	return req.headers['x-fly-admin'] === ADMIN_PASSWORD;
}

function sendJson(res, code, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(code, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
	});
	res.end(body);
}

function readBody(req) {
	return new Promise(function (resolve) {
		let data = '';
		let done = false;
		function finish(v) { if (!done) { done = true; resolve(v); } }
		req.on('data', function (c) {
			if (done) return;
			data += c;
			if (data.length > 65536) {
				req.removeAllListeners('data');
				req.removeAllListeners('end');
				try { req.destroy(); } catch (e) { /* ignore */ }
				finish(null);
			}
		});
		req.on('end', function () {
			if (done) return;
			try { finish(data ? JSON.parse(data) : {}); }
			catch (e) { finish(null); }
		});
		req.on('error', function () { finish(null); });
	});
}

function fullSnapshot() {
	return {
		world: behavior.world,
		brain: {
			neuronCount: host.neuronCount,
			edgeCount: host.edgeCount,
			groups: host.groupMeta.names,
			groupSizes: host.groupMeta.sizes,
			groupRegions: host.groupMeta.regions,
		},
		fly: behavior.getFlyState(),
		mission: mission.snapshot(),
		viewers: sseClients.size,
		config: {
			tokenConfigured: client.tokenConfigured,
			dryRun: client.dryRun,
			adminRequired: !!ADMIN_PASSWORD,
		},
	};
}

/* ---------- static files ---------- */

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
	if (urlPath === '/') urlPath = '/index.html';
	const normalized = path.posix.normalize(urlPath);
	// Only the spectator app is served; sim data/server code stay private.
	// Check the normalized path so /css/../server/... cannot escape.
	if (!/^\/(index\.html|css\/.+|js\/.+)/.test(normalized) || normalized.includes('..')) {
		res.writeHead(404); res.end('not found'); return;
	}
	const rel = normalized.replace(/^\//, '');
	const filePath = path.join(ROOT, rel);
	if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
	fs.readFile(filePath, function (err, buf) {
		if (err) { res.writeHead(404); res.end('not found'); return; }
		res.writeHead(200, {
			'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
			'Cache-Control': 'no-cache',
		});
		res.end(buf);
	});
}

/* ---------- server ---------- */

const server = http.createServer(async function (req, res) {
	const url = new URL(req.url, 'http://localhost');
	const p = url.pathname;

	if (req.method === 'GET') {
		if (p === '/api/health') {
			return sendJson(res, 200, {
				ok: true,
				brainReady: host.workerReady,
				neurons: host.neuronCount,
				mission: mission.state,
				viewers: sseClients.size,
			});
		}
		if (p === '/api/config') {
			return sendJson(res, 200, {
				tokenConfigured: client.tokenConfigured,
				dryRun: client.dryRun,
				adminRequired: !!ADMIN_PASSWORD,
			});
		}
		if (p === '/api/mission') {
			return sendJson(res, 200, fullSnapshot());
		}
		if (p === '/api/stream') {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-store',
				'Connection': 'keep-alive',
				'X-Accel-Buffering': 'no',
			});
			res.write(': welcome\n\n');
			sseClients.add(res);
			sseWrite(res, 'init', fullSnapshot());
			broadcast('viewers', { count: sseClients.size });
			req.on('close', function () {
				sseClients.delete(res);
				broadcast('viewers', { count: sseClients.size });
			});
			return;
		}
		return serveStatic(req, res, p);
	}

	if (req.method === 'POST') {
		if (p === '/api/mission/start' || p === '/api/mission/teardown' || p === '/api/mission/reset') {
			if (!isAdmin(req)) {
				return sendJson(res, 401, { ok: false, error: 'admin password required (x-fly-admin header)' });
			}
			if (p === '/api/mission/start') {
				const body = await readBody(req);
				if (!body || body.confirm !== true) {
					return sendJson(res, 400, { ok: false, error: 'body must be {"confirm": true} -- this creates REAL Railway services' });
				}
				if (!client.dryRun && !client.tokenConfigured) {
					return sendJson(res, 409, { ok: false, error: 'RAILWAY_TOKEN not configured (set DRY_RUN=1 to demo without one)' });
				}
				const r = await mission.start();
				return sendJson(res, r.ok ? 200 : (r.code || 500), r);
			}
			if (p === '/api/mission/teardown') {
				const r = await mission.teardown();
				return sendJson(res, r.ok ? 200 : (r.code || 500), r);
			}
			const r = mission.reset();
			return sendJson(res, r.ok ? 200 : (r.code || 500), r);
		}
		return sendJson(res, 404, { ok: false, error: 'not found' });
	}

	res.writeHead(405);
	res.end();
});

server.listen(PORT, function () {
	log('fly-brain-railway listening on :' + PORT +
		(client.dryRun ? ' [DRY_RUN]' : '') +
		(ADMIN_PASSWORD ? ' [admin gated]' : ' [admin OPEN -- set ADMIN_PASSWORD for public deploys]'));
});
