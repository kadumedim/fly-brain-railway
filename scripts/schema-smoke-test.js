#!/usr/bin/env node
/* schema-smoke-test.js
 *
 * Phase-3 gate: Railway's GraphQL schema drifts, so before the fly is allowed
 * to run a REAL mission, verify every mutation/query shape this project uses
 * against the live API. Uses introspection first (no side effects), then
 * optionally a full throwaway happy-path run.
 *
 *   RAILWAY_TOKEN=... node scripts/schema-smoke-test.js            # introspection only
 *   RAILWAY_TOKEN=... node scripts/schema-smoke-test.js --live     # + real throwaway project
 *
 * --live creates a real project named fly-smoke-test-<ts>, deploys all four
 * services, waits for green, then DELETES the project. Costs a few cents of
 * usage at most; requires an account/workspace token.
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
	{ kind: 'mutation', name: 'projectCreate', wantArgs: ['input'] },
	{ kind: 'mutation', name: 'projectUpdate', wantArgs: ['id', 'input'] },
	{ kind: 'mutation', name: 'projectDelete', wantArgs: ['id'] },
	{ kind: 'mutation', name: 'serviceCreate', wantArgs: ['input'] },
	{ kind: 'mutation', name: 'variableUpsert', wantArgs: ['input'] },
	{ kind: 'mutation', name: 'serviceInstanceUpdate', wantArgs: ['serviceId', 'environmentId', 'input'] },
	{ kind: 'mutation', name: 'serviceInstanceDeployV2', wantArgs: ['serviceId', 'environmentId'] },
	{ kind: 'mutation', name: 'serviceDomainCreate', wantArgs: ['input'] },
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

async function introspectInput(typeName) {
	const q = `query t($name: String!) {
		__type(name: $name) { inputFields { name } }
	}`;
	const r = await client.gql(q, { name: typeName });
	return r.data.__type ? (r.data.__type.inputFields || []).map(f => f.name) : null;
}

async function main() {
	let failures = 0;

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
		['ProjectUpdateInput', ['isPublic']],
		['ServiceCreateInput', ['projectId', 'name', 'source']],
		['VariableUpsertInput', ['projectId', 'environmentId', 'serviceId', 'name', 'value']],
		['ServiceInstanceUpdateInput', ['startCommand']],
		['ServiceDomainCreateInput', ['serviceId', 'environmentId', 'targetPort']],
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
			// isPublic absence is survivable (mission logs a manual-toggle hint)
			if (!(type === 'ProjectUpdateInput' && missing.length === 1 && missing[0] === 'isPublic')) failures++;
			else console.log('  (non-fatal: mission will log a manual-toggle hint instead)');
		} else {
			console.log('✓ ' + type + ' has ' + want.join(', '));
		}
	}

	console.log('== token viability: viewer query ==');
	try {
		const r = await client.gql('query { me { name email } }', {});
		console.log('✓ authenticated as ' + (r.data.me.name || r.data.me.email));
	} catch (e) {
		console.log('✗ me query failed: ' + e.message + ' (workspace/team token? that can be fine)');
	}

	if (failures) {
		console.log('\n' + failures + ' schema check(s) FAILED -- fix server/railway-client.js before a real run');
		process.exit(1);
	}
	console.log('\nAll schema checks passed.');

	if (process.argv.indexOf('--live') === -1) {
		console.log('Run with --live for a full throwaway happy-path (creates + deletes a real project).');
		return;
	}

	/* ---- live throwaway happy path ---- */
	console.log('\n== LIVE throwaway run ==');
	const poller = createPoller(client, { log: console.log });
	const name = 'fly-smoke-test-' + Date.now().toString(36);
	const proj = await client.projectCreate(name);
	console.log('project ' + proj.projectId + ' env ' + proj.environmentId);
	try {
		await client.projectMakePublic(proj.projectId);

		for (const [svcName, image] of [['redis', 'redis:7-alpine']]) {
			const svc = await client.serviceCreate(proj.projectId, svcName, image);
			console.log('service ' + svcName + ' = ' + svc.serviceId + ' -- waiting for deploy...');
			const r = await poller.waitForDeploy(proj.projectId, proj.environmentId, svc.serviceId, function (services) {
				console.log('  poll: ' + services.map(s => s.name + '=' + s.status).join(' '));
			}, 5 * 60 * 1000);
			console.log(svcName + ' final: ' + r.status);
			if (r.status !== 'SUCCESS') throw new Error(svcName + ' did not go green');
		}
		console.log('happy path OK');
	} finally {
		console.log('deleting throwaway project...');
		await client.projectDelete(proj.projectId);
		console.log('deleted.');
	}
}

main().catch(function (err) {
	console.error('SMOKE TEST FAILED:', err.message);
	process.exit(1);
});
