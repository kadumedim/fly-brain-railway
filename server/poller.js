/* poller.js
 *
 * Deployment-status polling with adaptive backoff. Only runs while a step is
 * VERIFYING. 20s base interval (2.5s in dry-run so the demo stays snappy),
 * backs off to 60s on 429 or low X-RateLimit-Remaining. A full mission run
 * stays well under Railway's free-tier 100 requests/hour.
 */
'use strict';

const PENDING_STATUSES = ['BUILDING', 'DEPLOYING', 'QUEUED', 'WAITING', 'INITIALIZING', 'NONE'];

function createPoller(client, opts) {
	opts = opts || {};
	const log = opts.log || function () {};
	const baseMs = opts.baseMs || (client.dryRun ? 2500 : 20000);
	const slowMs = opts.slowMs || 60000;

	/**
	 * Polls the combined project-status query until the named service reaches
	 * a terminal deployment state.
	 *
	 * waitOpts:
	 *  - onStatuses(services): every poll's full service list (for the HUD)
	 *  - excludeDeploymentId: a deployment that existed BEFORE this deploy was
	 *    triggered -- its status (stale SUCCESS or FAILED) never counts;
	 *    verification waits for a different deployment to appear
	 *  - isCancelled(): checked each cycle; a torn-down/superseded mission
	 *    stops its zombie poll instead of burning API calls for 10 minutes
	 *  - timeoutMs (default 10 min)
	 *
	 * Resolves {status: 'SUCCESS'|'FAILED'|'CRASHED'|'REMOVED'|'TIMEOUT'|'CANCELLED', services}.
	 */
	async function waitForDeploy(projectId, environmentId, serviceId, waitOpts) {
		waitOpts = waitOpts || {};
		const onStatuses = waitOpts.onStatuses || null;
		const excludeId = waitOpts.excludeDeploymentId || null;
		const isCancelled = waitOpts.isCancelled || function () { return false; };
		const deadline = Date.now() + (waitOpts.timeoutMs || 10 * 60 * 1000);
		let interval = baseMs;
		const warnedStatuses = {};
		for (;;) {
			if (isCancelled()) return { status: 'CANCELLED', services: [] };
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
				const stale = svc && excludeId && svc.deploymentId === excludeId;
				const status = svc && !stale ? svc.status : 'NONE';
				if (status === 'SUCCESS') return { status: 'SUCCESS', services: result.services };
				if (status === 'FAILED' || status === 'CRASHED' || status === 'REMOVED') {
					return { status: status, services: result.services };
				}
				// Surface unrecognized statuses (schema drift) instead of
				// letting them silently ride out the timeout
				if (PENDING_STATUSES.indexOf(status) === -1 && !warnedStatuses[status]) {
					warnedStatuses[status] = true;
					log('unrecognized deployment status "' + status + '" for ' + serviceId + ' -- treating as pending');
				}
			}
			if (Date.now() > deadline) return { status: 'TIMEOUT', services: result ? result.services : [] };
			await new Promise(function (r) { setTimeout(r, interval); });
		}
	}

	return { waitForDeploy: waitForDeploy };
}

module.exports = { createPoller };
