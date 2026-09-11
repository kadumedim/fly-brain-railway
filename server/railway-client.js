/* railway-client.js
 *
 * Zero-dependency GraphQL client for Railway's public API
 * (https://backboard.railway.com/graphql/v2).
 *
 * In-project model: the fly service is deployed INSIDE the project it builds.
 * A project token (scoped to exactly that project + environment) is all it
 * needs -- it authenticates via the `Project-Access-Token` header. Account /
 * workspace tokens (`Authorization: Bearer`) also work; set
 * RAILWAY_TOKEN_TYPE=account for those. Default is `project`.
 *
 * The project/environment the fly operates on comes from Railway's
 * auto-injected RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID env vars, with a
 * projectToken-query fallback (project tokens know their own scope).
 *
 * DRY_RUN=1 short-circuits every mutation: operations are logged, plausible
 * fake ids are returned, and deployments fake SUCCESS ~10s after deploy.
 * DRY_RUN_FAIL="<serviceName>:<n>" makes the first n deploys of that service
 * report FAILED (for exercising the nociception/retry path).
 *
 * NOTE: Railway's schema drifts. Mutation names/shapes here must be verified
 * against the live API before a real run (see scripts/schema-smoke-test.js).
 */
'use strict';

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

function createRailwayClient(opts) {
	opts = opts || {};
	const token = opts.token || process.env.RAILWAY_TOKEN || '';
	const tokenType = opts.tokenType || process.env.RAILWAY_TOKEN_TYPE || 'project';
	const dryRun = opts.dryRun !== undefined ? opts.dryRun : process.env.DRY_RUN === '1';
	const log = opts.log || function () {};

	/* ---- dry-run fake state ---- */
	const DRY_DEPLOY_MS = Number(process.env.DRY_RUN_DEPLOY_MS || 10000);
	const dryState = {
		services: {}, // serviceId -> {name, deployedAt, failLeft}
		serviceSeq: 0,
	};
	const dryFail = {}; // serviceName -> remaining forced failures
	(process.env.DRY_RUN_FAIL || '').split(',').forEach(function (spec) {
		const m = spec.trim().split(':');
		if (m[0]) dryFail[m[0]] = Number(m[1] || 1);
	});

	function authHeaders() {
		if (tokenType === 'project') {
			return { 'Project-Access-Token': token };
		}
		return { 'Authorization': 'Bearer ' + token };
	}

	async function gql(query, variables) {
		if (!token) throw new Error('RAILWAY_TOKEN is not configured');
		const headers = Object.assign(
			{ 'Content-Type': 'application/json' }, authHeaders());
		const res = await fetch(ENDPOINT, {
			method: 'POST',
			headers: headers,
			body: JSON.stringify({ query: query, variables: variables || {} }),
		});
		const rateRemaining = res.headers.get('x-ratelimit-remaining');
		if (res.status === 429) {
			const err = new Error('Railway API rate limited (429)');
			err.rateLimited = true;
			throw err;
		}
		let body;
		try {
			body = await res.json();
		} catch (e) {
			throw new Error('Railway API HTTP ' + res.status + ' (non-JSON body)');
		}
		if (!res.ok || (body.errors && body.errors.length)) {
			const msg = body.errors && body.errors.length
				? body.errors.map(function (e) { return e.message; }).join('; ')
				: 'HTTP ' + res.status;
			throw new Error('Railway API error: ' + msg);
		}
		return { data: body.data, rateRemaining: rateRemaining !== null ? Number(rateRemaining) : null };
	}

	/* ---- project context ---- */

	// Resolves the project/environment the fly operates on. Priority:
	// Railway's auto-injected env vars, then (project tokens only) asking the
	// API what scope the token is bound to.
	async function resolveProjectContext() {
		if (dryRun) {
			return { projectId: 'dry-project', environmentId: 'dry-env' };
		}
		if (process.env.RAILWAY_PROJECT_ID && process.env.RAILWAY_ENVIRONMENT_ID) {
			return {
				projectId: process.env.RAILWAY_PROJECT_ID,
				environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
			};
		}
		if (tokenType === 'project') {
			const q = `query projectToken { projectToken { projectId environmentId } }`;
			const r = await gql(q, {});
			return {
				projectId: r.data.projectToken.projectId,
				environmentId: r.data.projectToken.environmentId,
			};
		}
		throw new Error('Cannot resolve project: set RAILWAY_PROJECT_ID + RAILWAY_ENVIRONMENT_ID (auto-injected when running on Railway)');
	}

	/* ---- operations ---- */

	async function serviceCreate(projectId, name, image) {
		if (dryRun) {
			log('[dry-run] serviceCreate name=' + name + ' image=' + image);
			const id = 'dry-svc-' + (++dryState.serviceSeq) + '-' + name;
			dryState.services[id] = {
				name: name,
				deployedAt: Date.now(),
				failLeft: dryFail[name] || 0,
			};
			return { serviceId: id };
		}
		const q = `mutation serviceCreate($input: ServiceCreateInput!) {
			serviceCreate(input: $input) { id name }
		}`;
		const r = await gql(q, { input: { projectId: projectId, name: name, source: { image: image } } });
		return { serviceId: r.data.serviceCreate.id };
	}

	async function serviceDelete(serviceId, environmentId) {
		if (dryRun) {
			log('[dry-run] serviceDelete ' + serviceId);
			delete dryState.services[serviceId];
			return true;
		}
		const q = `mutation serviceDelete($id: String!, $environmentId: String) {
			serviceDelete(id: $id, environmentId: $environmentId)
		}`;
		await gql(q, { id: serviceId, environmentId: environmentId });
		return true;
	}

	async function variableUpsert(projectId, environmentId, serviceId, name, value) {
		if (dryRun) {
			// Never log values -- POSTGRES_PASSWORD flows through here
			log('[dry-run] variableUpsert ' + name + ' on ' + serviceId);
			return true;
		}
		const q = `mutation variableUpsert($input: VariableUpsertInput!) {
			variableUpsert(input: $input)
		}`;
		await gql(q, {
			input: {
				projectId: projectId,
				environmentId: environmentId,
				serviceId: serviceId,
				name: name,
				value: value,
			},
		});
		return true;
	}

	async function serviceInstanceUpdate(serviceId, environmentId, patch) {
		if (dryRun) {
			log('[dry-run] serviceInstanceUpdate ' + serviceId + ' ' + JSON.stringify(patch));
			return true;
		}
		const q = `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
			serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
		}`;
		await gql(q, { serviceId: serviceId, environmentId: environmentId, input: patch });
		return true;
	}

	async function serviceInstanceDeploy(serviceId, environmentId) {
		if (dryRun) {
			log('[dry-run] serviceInstanceDeployV2 ' + serviceId);
			const svc = dryState.services[serviceId];
			if (svc) svc.deployedAt = Date.now();
			return true;
		}
		const q = `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
			serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
		}`;
		await gql(q, { serviceId: serviceId, environmentId: environmentId });
		return true;
	}

	async function serviceDomainCreate(serviceId, environmentId, targetPort) {
		if (dryRun) {
			log('[dry-run] serviceDomainCreate :' + targetPort);
			return { domain: 'fly-deployed-web.dry-run.example' };
		}
		const q = `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
			serviceDomainCreate(input: $input) { domain }
		}`;
		const r = await gql(q, {
			input: { serviceId: serviceId, environmentId: environmentId, targetPort: targetPort },
		});
		return { domain: r.data.serviceDomainCreate.domain };
	}

	// One combined query: latest deployment status for every service in the
	// project. Railway's schema has drifted here before (Service.deployments
	// lost its `input` arg), so two shapes are tried and the winner is cached:
	//   1. services -> serviceInstances -> latestDeployment
	//   2. top-level deployments(input:{projectId, environmentId}) joined
	//      against the project's service list
	// Returns { services: [{serviceId, name, status}], rateRemaining }
	let statusQueryMode = null; // 'instances' | 'deployments'

	async function statusViaInstances(projectId, environmentId) {
		const q = `query projectStatus($id: String!) {
			project(id: $id) {
				services {
					edges {
						node {
							id
							name
							serviceInstances {
								edges { node { environmentId latestDeployment { id status } } }
							}
						}
					}
				}
			}
		}`;
		const r = await gql(q, { id: projectId });
		const services = r.data.project.services.edges.map(function (e) {
			const insts = e.node.serviceInstances.edges.map(function (x) { return x.node; });
			const inst = insts.find(function (n) { return n.environmentId === environmentId; }) || insts[0];
			return {
				serviceId: e.node.id,
				name: e.node.name,
				status: inst && inst.latestDeployment ? inst.latestDeployment.status : 'NONE',
			};
		});
		return { services: services, rateRemaining: r.rateRemaining };
	}

	async function statusViaDeployments(projectId, environmentId) {
		const qNames = `query serviceNames($id: String!) {
			project(id: $id) { services { edges { node { id name } } } }
		}`;
		const rNames = await gql(qNames, { id: projectId });
		const qDeps = `query deployments($input: DeploymentListInput!) {
			deployments(first: 50, input: $input) {
				edges { node { id status serviceId } }
			}
		}`;
		const rDeps = await gql(qDeps, { input: { projectId: projectId, environmentId: environmentId } });
		const latestByService = {};
		for (const e of rDeps.data.deployments.edges) {
			// connection is newest-first; keep the first status seen per service
			if (!(e.node.serviceId in latestByService)) {
				latestByService[e.node.serviceId] = e.node.status;
			}
		}
		const services = rNames.data.project.services.edges.map(function (e) {
			return {
				serviceId: e.node.id,
				name: e.node.name,
				status: latestByService[e.node.id] || 'NONE',
			};
		});
		return { services: services, rateRemaining: rDeps.rateRemaining };
	}

	async function projectStatus(projectId, environmentId) {
		if (dryRun) {
			const services = Object.keys(dryState.services).map(function (id) {
				const svc = dryState.services[id];
				let status = 'BUILDING';
				if (Date.now() - svc.deployedAt >= DRY_DEPLOY_MS) {
					if (svc.failLeft > 0) {
						status = 'FAILED';
					} else {
						status = 'SUCCESS';
					}
				}
				return { serviceId: id, name: svc.name, status: status };
			});
			return { services: services, rateRemaining: null };
		}
		if (statusQueryMode !== 'deployments') {
			try {
				const r = await statusViaInstances(projectId, environmentId);
				statusQueryMode = 'instances';
				return r;
			} catch (err) {
				if (statusQueryMode === 'instances') throw err; // shape known-good; real error
				log('instances status query failed (' + err.message + ') -- falling back to deployments query');
				statusQueryMode = 'deployments';
			}
		}
		return statusViaDeployments(projectId, environmentId);
	}

	// Dry-run helper: consume one forced failure after mission acknowledges it,
	// so the retry deploy can succeed.
	function dryRunAckFailure(serviceId) {
		const svc = dryState.services[serviceId];
		if (svc && svc.failLeft > 0) svc.failLeft--;
	}

	return {
		dryRun: dryRun,
		tokenConfigured: !!token,
		tokenType: tokenType,
		gql: gql,
		resolveProjectContext: resolveProjectContext,
		serviceCreate: serviceCreate,
		serviceDelete: serviceDelete,
		variableUpsert: variableUpsert,
		serviceInstanceUpdate: serviceInstanceUpdate,
		serviceInstanceDeploy: serviceInstanceDeploy,
		serviceDomainCreate: serviceDomainCreate,
		projectStatus: projectStatus,
		dryRunAckFailure: dryRunAckFailure,
	};
}

module.exports = { createRailwayClient };
