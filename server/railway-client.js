/* railway-client.js
 *
 * Zero-dependency GraphQL client for Railway's public API
 * (https://backboard.railway.com/graphql/v2). Requires an account/workspace
 * token (project tokens cannot projectCreate).
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
	const teamId = opts.teamId || process.env.RAILWAY_TEAM_ID || '';
	const dryRun = opts.dryRun !== undefined ? opts.dryRun : process.env.DRY_RUN === '1';
	const log = opts.log || function () {};

	/* ---- dry-run fake state ---- */
	const DRY_DEPLOY_MS = Number(process.env.DRY_RUN_DEPLOY_MS || 10000);
	const dryState = {
		projectId: null,
		environmentId: null,
		services: {}, // serviceId -> {name, deployedAt, failLeft}
		serviceSeq: 0,
	};
	const dryFail = {}; // serviceName -> remaining forced failures
	(process.env.DRY_RUN_FAIL || '').split(',').forEach(function (spec) {
		const m = spec.trim().split(':');
		if (m[0]) dryFail[m[0]] = Number(m[1] || 1);
	});

	async function gql(query, variables) {
		if (!token) throw new Error('RAILWAY_TOKEN is not configured');
		const res = await fetch(ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Bearer ' + token,
			},
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

	/* ---- operations ---- */

	async function projectCreate(name) {
		if (dryRun) {
			log('[dry-run] projectCreate name=' + name);
			dryState.projectId = 'dry-project-' + Date.now().toString(36);
			dryState.environmentId = 'dry-env';
			return { projectId: dryState.projectId, environmentId: dryState.environmentId };
		}
		const input = { name: name };
		if (teamId) input.teamId = teamId;
		const q = `mutation projectCreate($input: ProjectCreateInput!) {
			projectCreate(input: $input) {
				id
				environments { edges { node { id name } } }
			}
		}`;
		const r = await gql(q, { input: input });
		const p = r.data.projectCreate;
		const envs = p.environments.edges.map(function (e) { return e.node; });
		const env = envs.find(function (e) { return e.name === 'production'; }) || envs[0];
		if (!env) throw new Error('projectCreate returned no environments');
		return { projectId: p.id, environmentId: env.id };
	}

	// Best-effort: make the project publicly viewable so spectators can verify
	// on Railway's own dashboard. Schema availability of isPublic can drift.
	async function projectMakePublic(projectId) {
		if (dryRun) {
			log('[dry-run] projectUpdate isPublic=true');
			return true;
		}
		const q = `mutation projectUpdate($id: String!, $input: ProjectUpdateInput!) {
			projectUpdate(id: $id, input: $input) { id isPublic }
		}`;
		try {
			await gql(q, { id: projectId, input: { isPublic: true } });
			return true;
		} catch (err) {
			log('projectUpdate(isPublic) failed -- toggle it manually in project settings: ' + err.message);
			return false;
		}
	}

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

	// One combined query: latest deployment status for every service in the project.
	// Returns { services: [{serviceId, name, status}], rateRemaining }
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
		const q = `query projectStatus($id: String!, $environmentId: String!) {
			project(id: $id) {
				services {
					edges {
						node {
							id
							name
							deployments(first: 1, input: { environmentId: $environmentId }) {
								edges { node { id status } }
							}
						}
					}
				}
			}
		}`;
		const r = await gql(q, { id: projectId, environmentId: environmentId });
		const services = r.data.project.services.edges.map(function (e) {
			const node = e.node;
			const dep = node.deployments.edges[0];
			return {
				serviceId: node.id,
				name: node.name,
				status: dep ? dep.node.status : 'NONE',
			};
		});
		return { services: services, rateRemaining: r.rateRemaining };
	}

	// Dry-run helper: consume one forced failure after mission acknowledges it,
	// so the retry deploy can succeed.
	function dryRunAckFailure(serviceId) {
		const svc = dryState.services[serviceId];
		if (svc && svc.failLeft > 0) svc.failLeft--;
	}

	async function projectDelete(projectId) {
		if (dryRun) {
			log('[dry-run] projectDelete ' + projectId);
			dryState.services = {};
			dryState.projectId = null;
			return true;
		}
		const q = `mutation projectDelete($id: String!) { projectDelete(id: $id) }`;
		await gql(q, { id: projectId });
		return true;
	}

	return {
		dryRun: dryRun,
		tokenConfigured: !!token,
		gql: gql,
		projectCreate: projectCreate,
		projectMakePublic: projectMakePublic,
		serviceCreate: serviceCreate,
		variableUpsert: variableUpsert,
		serviceInstanceUpdate: serviceInstanceUpdate,
		serviceInstanceDeploy: serviceInstanceDeploy,
		serviceDomainCreate: serviceDomainCreate,
		projectStatus: projectStatus,
		projectDelete: projectDelete,
		dryRunAckFailure: dryRunAckFailure,
	};
}

module.exports = { createRailwayClient };
