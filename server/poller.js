/* poller.js
 *
 * Deployment-status polling with adaptive backoff. Only runs while a step is
 * VERIFYING. 20s base interval (2.5s in dry-run so the demo stays snappy),
 * backs off to 60s on 429 or low X-RateLimit-Remaining. A full mission run
 * stays well under Railway's free-tier 100 requests/hour.
 */
'use strict';

function createPoller(client, opts) {
	opts = opts || {};
	const log = opts.log || function () {};
	const baseMs = opts.baseMs || (client.dryRun ? 2500 : 20000);
	const slowMs = opts.slowMs || 60000;

	/**
	 * Polls the combined project-status query until the named service reaches
	 * a terminal deployment state.
	 * onStatuses (optional) receives every poll's full service list (for HUD).
	 * Resolves {status: 'SUCCESS'|'FAILED'|'CRASHED'|'TIMEOUT', services}.
	 */
	async function waitForDeploy(projectId, environmentId, serviceId, onStatuses, timeoutMs) {
		const deadline = Date.now() + (timeoutMs || 10 * 60 * 1000);
		let interval = baseMs;
		for (;;) {
			let result = null;
			try {
				result = await client.projectStatus(projectId, environmentId);
				interval = baseMs;
				if (result.rateRemaining !== null && result.rateRemaining < 10) {
					interval = slowMs;
				}
			} catch (err) {
				log('status poll failed: ' + err.message);
				interval = err.rateLimited ? slowMs : Math.min(interval * 2, slowMs);
			}
			if (result) {
				if (onStatuses) onStatuses(result.services);
				const svc = result.services.find(function (s) { return s.serviceId === serviceId; });
				const status = svc ? svc.status : 'NONE';
				if (status === 'SUCCESS') return { status: 'SUCCESS', services: result.services };
				if (status === 'FAILED' || status === 'CRASHED' || status === 'REMOVED') {
					return { status: status, services: result.services };
				}
			}
			if (Date.now() > deadline) return { status: 'TIMEOUT', services: result ? result.services : [] };
			await new Promise(function (r) { setTimeout(r, interval); });
		}
	}

	return { waitForDeploy: waitForDeploy };
}

module.exports = { createPoller };
