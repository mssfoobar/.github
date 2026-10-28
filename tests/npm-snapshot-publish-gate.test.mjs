// Tests the content gate in .github/workflows/npm-snapshot-publish.yml.
//
// The gate is inline JavaScript inside a `node -e "..."` step, because a
// reusable workflow runs in the caller's checkout and cannot load a script
// file from this repository. So the test reads the helpers out of the YAML
// itself, between the `pure helpers` and `candidate set` markers, and undoes
// bash's double-quote escaping. What runs here is what runs in CI.
//
// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yaml = fs.readFileSync(new URL('../.github/workflows/npm-snapshot-publish.yml', import.meta.url), 'utf8');
const start = yaml.indexOf('// ---- pure helpers');
const end = yaml.indexOf('// ---- candidate set');
assert.ok(start > 0 && end > start, 'helper markers not found in npm-snapshot-publish.yml');
// Inside double quotes bash drops the backslash before \\ \$ \" and \`.
const helpers = yaml.slice(start, end).replace(/\\([\\$"`])/g, '$1');

function loadGate(committed) {
	// buildDepGraph reads each candidate's committed manifest with `git show HEAD:<path>`.
	const execSync = (cmd) => {
		const m = /^git show HEAD:(.+)\/package\.json$/.exec(cmd);
		if (!m || !(m[1] in committed)) throw new Error('unexpected command: ' + cmd);
		return JSON.stringify(committed[m[1]]);
	};
	return new Function('execSync', helpers + '\nreturn { computePublishSet, buildDepGraph, buildRequireGraph };')(execSync);
}

// ops-hub's internal specs as committed on develop (2026-10-28).
const committed = {
	'packages/ui': { name: '@mssfoobar/ui' },
	'packages/errors': { name: '@mssfoobar/errors' },
	'packages/logger': { name: '@mssfoobar/logger' },
	'packages/sse-client': { name: '@mssfoobar/sse-client' },
	'modules/sds/client': { name: '@mssfoobar/sds-client' },
	'packages/auth-sdk': { name: '@mssfoobar/auth-sdk', peerDependencies: { '@mssfoobar/sds-client': '>=0.0.5' } },
	'modules/msr/client': { name: '@mssfoobar/msr-client' },
	'modules/msr/web': {
		name: '@mssfoobar/msr-web-sdk',
		dependencies: { '@mssfoobar/msr-client': 'workspace:*' },
		peerDependencies: { '@mssfoobar/logger': 'workspace:^', '@mssfoobar/ui': 'workspace:^' },
	},
	'modules/gis/web': {
		name: '@mssfoobar/gis-web-sdk',
		peerDependencies: { '@mssfoobar/logger': 'workspace:^', '@mssfoobar/sse-client': 'workspace:^', '@mssfoobar/ui': 'workspace:^' },
	},
	'modules/unh/web': {
		name: '@mssfoobar/unh-web-sdk',
		dependencies: { '@mssfoobar/errors': 'workspace:*' },
		peerDependencies: { '@mssfoobar/logger': 'workspace:^', '@mssfoobar/ui': 'workspace:^' },
	},
	'modules/iams/web': {
		name: '@mssfoobar/iams-web-sdk',
		peerDependencies: { '@mssfoobar/auth-sdk': 'workspace:^2.0.0 || ^3.0.0', '@mssfoobar/logger': 'workspace:^', '@mssfoobar/ui': 'workspace:^' },
	},
	'modules/rag/web': { name: '@mssfoobar/rag-web-sdk', peerDependencies: { '@mssfoobar/logger': '^1.1.0' } },
};
const pathOf = Object.fromEntries(Object.entries(committed).map(([dir, m]) => [m.name, dir]));
const SNAP = '-alpha.42';

// `moved` lists the packages a pending changeset bumped this run; the others
// kept their version and are not candidates. The bumped manifest is what
// `changeset version --snapshot` leaves on disk: workspace: specs untouched,
// and any other internal range the snapshot falls outside of rewritten to the
// snapshot version (how auth-sdk's `>=0.0.5` peer became `1.2.0-alpha.1143`
// in the published auth-sdk 3.0.0-alpha.1143).
function publishSet(moved, changedPaths) {
	const gate = loadGate(committed);
	const candidates = moved.map((name) => ({ name, path: pathOf[name], newVersion: '9.9.9' + SNAP }));
	const readBumped = (c) => {
		const pkg = structuredClone(committed[c.path]);
		for (const sect of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
			for (const [dn, spec] of Object.entries(pkg[sect] || {})) {
				const d = candidates.find((x) => x.name === dn);
				if (d && !spec.startsWith('workspace:')) pkg[sect][dn] = d.newVersion;
			}
		}
		return pkg;
	};
	const set = gate.computePublishSet(candidates, changedPaths, gate.buildDepGraph(candidates), gate.buildRequireGraph(candidates, readBumped));
	return [...set].sort();
}

const allMoved = Object.values(committed).map((m) => m.name);

test('msr-web-sdk changed: its unchanged dependency msr-client publishes too', () => {
	assert.ok(publishSet(allMoved, ['modules/msr/web/sdk/index.ts']).includes('@mssfoobar/msr-client'));
});

test('gis-web-sdk changed: its workspace peer sse-client publishes too', () => {
	assert.ok(publishSet(allMoved, ['modules/gis/web/sdk/index.ts']).includes('@mssfoobar/sse-client'));
});

test('unh-web-sdk changed: its dependency errors publishes too', () => {
	assert.ok(publishSet(allMoved, ['modules/unh/web/sdk/index.ts']).includes('@mssfoobar/errors'));
});

test('iams-web-sdk changed: auth-sdk (a ranged workspace peer) and, transitively, sds-client publish', () => {
	const set = publishSet(allMoved, ['modules/iams/web/sdk/index.ts']);
	assert.ok(set.includes('@mssfoobar/auth-sdk'));
	assert.ok(set.includes('@mssfoobar/sds-client'));
});

test('auth-sdk changed: sds-client, a non-workspace peer changesets rewrote to the snapshot, publishes', () => {
	assert.ok(publishSet(allMoved, ['packages/auth-sdk/src/index.ts']).includes('@mssfoobar/sds-client'));
});

test('msr-web-sdk changed: exactly it and what it pins publish, nothing unrelated', () => {
	assert.deepEqual(publishSet(allMoved, ['modules/msr/web/sdk/index.ts']), [
		'@mssfoobar/logger',
		'@mssfoobar/msr-client',
		'@mssfoobar/msr-web-sdk',
		'@mssfoobar/ui',
	]);
});

test('a package added only because it is pinned does not pull in its other dependents', () => {
	// ui is pinned by msr-web-sdk; gis, unh and iams also peer on it but did not change.
	const set = publishSet(allMoved, ['modules/msr/web/sdk/index.ts']);
	for (const n of ['@mssfoobar/gis-web-sdk', '@mssfoobar/unh-web-sdk', '@mssfoobar/iams-web-sdk']) assert.ok(!set.includes(n), n);
});

test('a pinned package whose version did not move is not added', () => {
	// msr-client has no pending changeset: its published version is what pnpm writes.
	const set = publishSet(allMoved.filter((n) => n !== '@mssfoobar/msr-client'), ['modules/msr/web/sdk/index.ts']);
	assert.ok(!set.includes('@mssfoobar/msr-client'));
	assert.ok(set.includes('@mssfoobar/msr-web-sdk'));
});

test('rag-web-sdk changed: logger, pinned through a rewritten registry range, publishes', () => {
	assert.deepEqual(publishSet(allMoved, ['modules/rag/web/sdk/index.ts']), ['@mssfoobar/logger', '@mssfoobar/rag-web-sdk']);
});

test('buildRequireGraph: a spec that is neither workspace: nor the snapshot version is no edge', () => {
	const gate = loadGate(committed);
	const candidates = [
		{ name: 'a', path: 'a', newVersion: '1.0.1-alpha.42' },
		{ name: 'b', path: 'b', newVersion: '2.0.1-alpha.42' },
		{ name: 'c', path: 'c', newVersion: '3.0.1-alpha.42' },
	];
	const bumped = {
		a: { peerDependencies: { b: '^2.0.0', c: '>=3.0.0' } },
		b: { dependencies: { c: '3.0.1-alpha.42' } },
		c: { optionalDependencies: { a: 'workspace:~' } },
	};
	assert.deepEqual(gate.buildRequireGraph(candidates, (c) => bumped[c.name]), { a: [], b: ['c'], c: ['a'] });
});

test('nothing changed: nothing publishes', () => {
	assert.deepEqual(publishSet(allMoved, ['README.md']), []);
});

test('existing behaviour kept: a changed dependency still republishes its dependents', () => {
	// errors changed; unh depends on it through `dependencies`.
	assert.ok(publishSet(allMoved, ['packages/errors/src/index.ts']).includes('@mssfoobar/unh-web-sdk'));
});
