#!/usr/bin/env node
/* schema-smoke-test.js
 *
 * Phase-3 gate: Railway's GraphQL schema drifts, so before the fly is allowed
 * to run a REAL mission, verify every mutation/query shape this project uses
 * against the live API. Uses introspection first (no side effects), then
 * optionally a real throwaway service in the current project.
 *
 *   RAILWAY_TOKEN=<project token> node scripts/schema-smoke-test.js          # introspection only
 *   RAILWAY_TOKEN=<project token> node scripts/schema-smoke-test.js --live   # + real throwaway service
 *
 * Set RAILWAY_TOKEN_TYPE=account to test with an account/workspace token
 * (Bearer auth) instead of the default project token (Project-Access-Token).
 *
 * --live creates a real redis service named fly-smoke-test-<ts> in the
 * token's project, waits for it to go green, then DELETES it. Costs a few
 * cents of usage at most. Run it in the project you deployed the fly into.
 */
'use strict';

const { createRailwayClient } = require('../server/railway-client.js');
const { createPoller } = require('../server/poller.js');

const token = process.env.RAILWAY_TOKEN;
if (!token) {
	console.error('RAILWAY_TOKEN is required');
	process.exit(1);
}

const client = createRailwayClient({ token: token, dryRun: false, log: console.log });

const CHECKS = [
	{ name: 'serviceCreate', wantArgs: ['input'] },
	{ name: 'serviceDelete', wantArgs: ['id', 'environmentId'] },
	{ name: 'variableUpsert', wantArgs: ['input'] },
	{ name: 'serviceInstanceUpdate', wantArgs: ['serviceId', 'environmentId', 'input'] },
	{ name: 'serviceInstanceDeployV2', wantArgs: ['serviceId', 'environmentId'] },
	{ name: 'serviceDomainCreate', wantArgs: ['input'] },
];

async function introspectFields(typeName) {
	const q = `query t($name: String!) {
		__type(name: $name) {
			fields { name args { name } }
		}
	}`;
	const r = await client.gql(q, { name: typeName });
	return r.data.__type.fields;
}

async function introspectFieldNames(typeName) {
	const q = `query t($name: String!) {
		__type(name: $name) { fields { name } }
	}`;
	const r = await client.gql(q, { name: typeName });
	return r.data.__type ? (r.data.__type.fields || []).map(f => f.name) : null;
}

async function introspectInput(typeName) {
	const q = `query t($name: String!) {
		__type(name: $name) { inputFields { name } }
	}`;
	const r = await client.gql(q, { name: typeName });
	return r.data.__type ? (r.data.__type.inputFields || []).map(f => f.name) : null;
}

async function main() {
	let failures = 0;
	console.log('token type: ' + client.tokenType);

	console.log('== resolving project context ==');
	let ctx;
	try {
		ctx = await client.resolveProjectContext();
		console.log('✓ project ' + ctx.projectId + ' / environment ' + ctx.environmentId);
	} catch (e) {
		console.log('✗ cannot resolve project: ' + e.message);
		failures++;
	}

	console.log('== introspecting Mutation fields ==');
	const mutations = await introspectFields('Mutation');
	for (const check of CHECKS) {
		const f = mutations.find(m => m.name === check.name);
		if (!f) {
			console.log('✗ MISSING mutation: ' + check.name);
			failures++;
			continue;
		}
		const argNames = f.args.map(a => a.name);
		const missing = check.wantArgs.filter(a => argNames.indexOf(a) === -1);
		if (missing.length) {
			console.log('✗ ' + check.name + ' missing args: ' + missing.join(', ') + ' (has: ' + argNames.join(', ') + ')');
			failures++;
		} else {
			console.log('✓ ' + check.name + '(' + argNames.join(', ') + ')');
		}
	}

	console.log('== input type shapes ==');
	const inputChecks = [
		['ServiceCreateInput', ['projectId', 'name', 'source']],
		['VariableUpsertInput', ['projectId', 'environmentId', 'serviceId', 'name', 'value']],
		['ServiceInstanceUpdateInput', ['startCommand']],
		['ServiceDomainCreateInput', ['serviceId', 'environmentId', 'targetPort']],
		// the runtime's fallback status query depends on this shape
		['DeploymentListInput', ['projectId', 'environmentId']],
	];
	for (const [type, want] of inputChecks) {
		const fields = await introspectInput(type);
		if (!fields) {
			console.log('✗ MISSING input type: ' + type);
			failures++;
			continue;
		}
		const missing = want.filter(w => fields.indexOf(w) === -1);
		if (missing.length) {
			console.log('✗ ' + type + ' missing fields: ' + missing.join(', '));
			failures++;
		} else {
			console.log('✓ ' + type + ' has ' + want.join(', '));
		}
	}

	console.log('== status query shapes ==');
	const siFields = await introspectFieldNames('ServiceInstance');
	if (siFields && siFields.indexOf('latestDeployment') !== -1) {
		console.log('✓ ServiceInstance.latestDeployment exists (primary poll shape)');
	} else {
		console.log('- ServiceInstance.latestDeployment missing -- poller will fall back to deployments query');
	}

	console.log('== combined status query (live) ==');
	if (ctx) {
		try {
			const st = await client.projectStatus(ctx.projectId, ctx.environmentId);
			console.log('✓ projectStatus: ' + (st.services.length
				? st.services.map(s => s.name + '=' + s.status).join(' ')
				: '(no services yet)'));
		} catch (e) {
			console.log('✗ projectStatus failed (both shapes): ' + e.message);
			failures++;
		}
	}

	if (failures) {
		console.log('\n' + failures + ' schema check(s) FAILED -- fix server/railway-client.js before a real run');
		process.exit(1);
	}
	console.log('\nAll schema checks passed.');

	if (process.argv.indexOf('--live') === -1) {
		console.log('Run with --live for a full throwaway happy-path (creates + deletes a real service in this project).');
		return;
	}

	/* ---- live throwaway happy path ---- */
	console.log('\n== LIVE throwaway service ==');
	const poller = createPoller(client, { log: console.log });
	const name = 'fly-smoke-test-' + Date.now().toString(36);
	const svc = await client.serviceCreate(ctx.projectId, name, 'redis:7-alpine');
	console.log('service ' + name + ' = ' + svc.serviceId + ' -- triggering deploy...');
	try {
		// serviceCreate does NOT auto-deploy (verified live)
		await client.serviceInstanceDeploy(svc.serviceId, ctx.environmentId);
		const r = await poller.waitForDeploy(ctx.projectId, ctx.environmentId, svc.serviceId, {
			onStatuses: function (services) {
				console.log('  poll: ' + services.map(s => s.name + '=' + s.status).join(' '));
			},
			timeoutMs: 5 * 60 * 1000,
		});
		console.log('final: ' + r.status);
		if (r.status !== 'SUCCESS') throw new Error('throwaway service did not go green');
		console.log('happy path OK');
	} finally {
		console.log('deleting throwaway service...');
		await client.serviceDelete(svc.serviceId, ctx.environmentId);
		console.log('deleted.');
	}
}

main().catch(function (err) {
	console.error('SMOKE TEST FAILED:', err.message);
	process.exit(1);
});
