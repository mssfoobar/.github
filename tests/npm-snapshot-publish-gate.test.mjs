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
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync as realExecSync } from 'node:child_process';

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
	// A helper missing from the YAML comes back undefined, so only the tests that need it fail.
	const names = ['computePublishSet', 'buildDepGraph', 'buildRequireGraph', 'sortForPublish', 'dependencyBuildCommand'];
	const exported = names.map((n) => n + ": typeof " + n + " === 'function' ? " + n + ' : undefined').join(', ');
	return new Function('execSync', helpers + '\nreturn { ' + exported + ' };')(execSync);
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
	'modules/form/types': { name: '@mssfoobar/form-types' },
	'modules/form/client': { name: '@mssfoobar/form-client', dependencies: { '@mssfoobar/form-types': 'workspace:*' } },
};
const pathOf = Object.fromEntries(Object.entries(committed).map(([dir, m]) => [m.name, dir]));
const SNAP = '-alpha.42';

// `moved` lists the packages a pending changeset bumped this run; the others
// kept their version and are not candidates. The bumped manifest is what
// `changeset version --snapshot` leaves on disk: workspace: specs untouched,
// and any other internal range the snapshot falls outside of rewritten to the
// snapshot version (how auth-sdk's `>=0.0.5` peer became `1.2.0-alpha.1143`
// in the published auth-sdk 3.0.0-alpha.1143).
function gateFor(moved) {
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
	return { gate, candidates, requireGraph: gate.buildRequireGraph(candidates, readBumped) };
}

function publishSet(moved, changedPaths, pinnedBy) {
	const { gate, candidates, requireGraph } = gateFor(moved);
	const set = gate.computePublishSet(candidates, changedPaths, gate.buildDepGraph(candidates), requireGraph, pinnedBy);
	return [...set].sort();
}

const allMoved = Object.values(committed).map((m) => m.name);

test('msr-web-sdk changed: its unchanged dependency msr-client publishes too', () => {
	assert.ok(publishSet(allMoved, ['modules/msr/web/sdk/index.ts']).includes('@mssfoobar/msr-client'));
});

test('form-client changed: the types package it pins, form-types, publishes too', () => {
	// form-client@2.1.0-alpha.1043 was published pinning form-types@2.1.0-alpha.1043, which never was.
	const set = publishSet(allMoved, ['modules/form/client/src/index.ts']);
	assert.ok(set.includes('@mssfoobar/form-client'));
	assert.ok(set.includes('@mssfoobar/form-types'));
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

test('pinnedBy names the package that pulled each pinned package in', () => {
	const pinnedBy = {};
	publishSet(allMoved, ['modules/iams/web/sdk/index.ts'], pinnedBy);
	assert.deepEqual(pinnedBy['@mssfoobar/auth-sdk'], ['@mssfoobar/iams-web-sdk']);
	assert.deepEqual(pinnedBy['@mssfoobar/sds-client'], ['@mssfoobar/auth-sdk']);
	assert.equal(pinnedBy['@mssfoobar/iams-web-sdk'], undefined);
});

test('pinnedBy lists every pinner in the publish set, in input order', () => {
	// gis-web-sdk and msr-web-sdk both changed, and both peer on ui and logger.
	const pinnedBy = {};
	publishSet(allMoved, ['modules/gis/web/sdk/index.ts', 'modules/msr/web/sdk/index.ts'], pinnedBy);
	assert.deepEqual(pinnedBy['@mssfoobar/ui'], ['@mssfoobar/msr-web-sdk', '@mssfoobar/gis-web-sdk']);
	assert.deepEqual(pinnedBy['@mssfoobar/logger'], ['@mssfoobar/msr-web-sdk', '@mssfoobar/gis-web-sdk']);
	// unh-web-sdk also peers on ui but is not in the publish set.
	assert.ok(!pinnedBy['@mssfoobar/ui'].includes('@mssfoobar/unh-web-sdk'));
});

// pnpm list -r order in ops-hub puts packages/ before modules/, but dependents
// such as gis-web-sdk still appear before some of what they pin. Use an order
// with every pinner first to make the sort do the work.
const pinnersFirst = [
	'@mssfoobar/gis-web-sdk', '@mssfoobar/iams-web-sdk', '@mssfoobar/msr-web-sdk', '@mssfoobar/unh-web-sdk',
	'@mssfoobar/auth-sdk', '@mssfoobar/rag-web-sdk', '@mssfoobar/sse-client', '@mssfoobar/ui', '@mssfoobar/logger',
	'@mssfoobar/errors', '@mssfoobar/msr-client', '@mssfoobar/sds-client',
];

test('sortForPublish puts every pinned package before the package that pins it', () => {
	const { gate, candidates, requireGraph } = gateFor(pinnersFirst);
	const order = gate.sortForPublish(candidates, requireGraph).map((c) => c.name);
	const before = (a, b) => assert.ok(order.indexOf(a) < order.indexOf(b), a + ' before ' + b + ' in ' + order.join(', '));
	before('@mssfoobar/sse-client', '@mssfoobar/gis-web-sdk');
	before('@mssfoobar/ui', '@mssfoobar/gis-web-sdk');
	before('@mssfoobar/auth-sdk', '@mssfoobar/iams-web-sdk');
	before('@mssfoobar/sds-client', '@mssfoobar/auth-sdk');
	before('@mssfoobar/msr-client', '@mssfoobar/msr-web-sdk');
	before('@mssfoobar/errors', '@mssfoobar/unh-web-sdk');
	assert.equal(order.length, candidates.length);
});

test('sortForPublish keeps the input order when nothing pins anything', () => {
	const { gate } = gateFor([]);
	const list = [{ name: 'c' }, { name: 'a' }, { name: 'b' }];
	assert.deepEqual(gate.sortForPublish(list, {}).map((c) => c.name), ['c', 'a', 'b']);
});

test('sortForPublish terminates on a cycle, and packages whose pins reach no cycle stay ordered', () => {
	// Only the guarantees: every package once, and everything outside the cycle's
	// reach published first and in order. Around the cycle the order is unspecified.
	const { gate } = gateFor([]);
	const list = [{ name: 'top' }, { name: 'x' }, { name: 'y' }, { name: 'p' }, { name: 'leaf' }, { name: 'q' }];
	const graph = { top: ['x'], x: ['y'], y: ['x', 'leaf'], p: ['q'] };
	const order = gate.sortForPublish(list, graph).map((c) => c.name);
	assert.deepEqual([...order].sort(), ['leaf', 'p', 'q', 'top', 'x', 'y']);
	const at = (n) => order.indexOf(n);
	assert.ok(at('q') < at('p'), 'q before p');
	for (const n of ['leaf', 'p', 'q']) for (const c of ['top', 'x', 'y']) assert.ok(at(n) < at(c), n + ' before ' + c);
});

test('sortForPublish breaks a cycle at its first member in input order', () => {
	// top only pins the cycle; the first package published from it is x, a member.
	const { gate } = gateFor([]);
	const list = [{ name: 'top' }, { name: 'x' }, { name: 'y' }];
	const order = gate.sortForPublish(list, { top: ['x'], x: ['y'], y: ['x'] }).map((c) => c.name);
	assert.equal(order[0], 'x');
	assert.equal(order.length, 3);
});

test('the publish loop consumes the sorted list', () => {
	// The sort only helps if it runs before both the dry-run report and the publish loop.
	const sortAt = yaml.indexOf('toPublish = sortForPublish(toPublish, requireGraph);');
	assert.ok(sortAt > 0, 'sortForPublish is not applied to toPublish');
	assert.ok(sortAt < yaml.indexOf('if (dryRun) {'), 'sort runs after the dry-run report');
	assert.ok(sortAt < yaml.indexOf('for (const pkg of toPublish) {'), 'sort runs after the publish loop starts');
});

// ---- build-workspace-dependencies ----
// Release run 40644722805: observability's prepack build failed to resolve
// @mssfoobar/logger, a workspace:* dependency with no pending changeset, so it
// was neither published nor built in that run.

test('dependencyBuildCommand: observability builds its dependencies, not itself', () => {
	const { gate } = gateFor([]);
	assert.equal(
		gate.dependencyBuildCommand([{ name: '@mssfoobar/observability', path: 'packages/observability' }], 'build'),
		'pnpm --filter "{./packages/observability}^..." run --if-present build',
	);
});

test('dependencyBuildCommand: several packages share one command, one filter each, in order', () => {
	const { gate } = gateFor([]);
	const list = [
		{ name: '@mssfoobar/auth-sdk', path: 'packages/auth-sdk' },
		{ name: '@mssfoobar/observability', path: 'packages/observability' },
		{ name: '@mssfoobar/gis-web-sdk', path: 'modules/gis/web' },
	];
	assert.equal(
		gate.dependencyBuildCommand(list, 'build'),
		'pnpm --filter "{./packages/auth-sdk}^..." --filter "{./packages/observability}^..." --filter "{./modules/gis/web}^..." run --if-present build',
	);
});

test('dependencyBuildCommand: nothing to publish means no command', () => {
	const { gate } = gateFor([]);
	assert.equal(gate.dependencyBuildCommand([], 'build'), null);
});

test('dependencyBuildCommand: the root is left out, and a root-only list means no command', () => {
	const { gate } = gateFor([]);
	assert.equal(gate.dependencyBuildCommand([{ name: 'root', path: '.' }], 'build'), null);
	assert.equal(
		gate.dependencyBuildCommand([{ name: 'root', path: '.' }, { name: 'b', path: 'packages/b' }], 'build'),
		'pnpm --filter "{./packages/b}^..." run --if-present build',
	);
});

test('dependencyBuildCommand: uses the configured script name', () => {
	const { gate } = gateFor([]);
	assert.equal(gate.dependencyBuildCommand([{ name: 'b', path: 'packages/b' }], 'build:lib'), 'pnpm --filter "{./packages/b}^..." run --if-present build:lib');
});

test('dependencyBuildCommand quotes paths the way the publish command does', () => {
	// Both are double-quoted filters built inside the same node -e string.
	const run = yaml.slice(yaml.indexOf('// ---- content gate')).replace(/\\([\\$"`])/g, '$1');
	assert.ok(run.includes(`cmd = 'pnpm --filter "' + filter + '" publish --tag '`), 'publish filter quoting changed');
	const { gate } = gateFor([]);
	assert.match(gate.dependencyBuildCommand([{ name: 'b', path: 'packages/b' }], 'build'), /--filter "\{\.\/packages\/b\}\^\.\.\."/);
});

test('the dependency build runs after the sort and before the first publish, and dry-run reports it', () => {
	const sortAt = yaml.indexOf('toPublish = sortForPublish(toPublish, requireGraph);');
	const cmdAt = yaml.indexOf('const buildCmd = buildDeps ? dependencyBuildCommand(toPublish, buildScript) : null;');
	const dryAt = yaml.indexOf('if (dryRun) {');
	const runAt = yaml.indexOf('execSync(buildCmd, { stdio:');
	const loopAt = yaml.indexOf('for (const pkg of toPublish) {');
	assert.ok(sortAt > 0 && cmdAt > sortAt, 'command built after the sort');
	assert.ok(yaml.slice(dryAt, runAt).includes('would build workspace dependencies first'), 'dry-run reports the build');
	assert.ok(runAt > dryAt && runAt < loopAt, 'build runs before the publish loop');
});

test('build-workspace-dependencies defaults off and fails fast without pnpm', () => {
	assert.match(yaml, /build-workspace-dependencies:\n\s+required: false\n\s+type: boolean\n\s+default: false/);
	const guard = yaml.indexOf('if (buildDeps && pm !== ');
	assert.ok(guard > 0 && guard < yaml.indexOf('// ---- content gate'), 'npm guard runs before anything publishes');
});

// ---- content-base-sha ----
// ops-hub, 2026-11-02: three merges landed close together. The caller queues its
// publish runs, and GitHub keeps one waiting run per concurrency group, so the
// second push's run was cancelled before it started. The third run compared
// against the previous push (github.event.before), which is the second commit,
// and skipped the package that commit changed. Nothing published it.

// The helpers with the real execSync, run inside `cwd`. `calls` records every command.
function loadGateIn(cwd, calls = []) {
	const execSync = (cmd, opts = {}) => {
		calls.push(cmd);
		return realExecSync(cmd, { ...opts, cwd });
	};
	return new Function('execSync', helpers + '\nreturn { computePublishSet, buildDepGraph, buildRequireGraph, resolveBase };')(execSync);
}

// A repository with three packages and three pushes, each changing one package.
function threePushes(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-gate-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
	git('init', '-q', '-b', 'trunk');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'test');
	git('config', 'commit.gpgsign', 'false');
	const names = ['a', 'b', 'c'];
	for (const n of names) {
		fs.mkdirSync(path.join(dir, 'packages', n), { recursive: true });
		fs.writeFileSync(path.join(dir, 'packages', n, 'package.json'), JSON.stringify({ name: n }));
	}
	git('add', '.');
	git('commit', '-q', '-m', 'start');
	const start = git('rev-parse', 'HEAD');
	const pushes = names.map((n) => {
		fs.writeFileSync(path.join(dir, 'packages', n, 'index.js'), '// changed\n');
		git('add', '.');
		git('commit', '-q', '-m', 'change ' + n);
		return git('rev-parse', 'HEAD');
	});
	const candidates = names.map((n) => ({ name: n, path: 'packages/' + n, newVersion: '1.0.0' + SNAP }));
	return { dir, git, start, pushes, candidates };
}

// The publish step itself, as bash hands it to node. The step is a `node -e "..."`
// inside a `run:` block, so bash un-escapes the script before node sees it. A
// stand-in `node` on PATH captures that script; the tests then run it with the
// real node. What runs here is the step's own code, glue included.
let renderedStep;
function stepScript(t) {
	if (renderedStep) return renderedStep;
	const at = yaml.indexOf('      - name: Detect changed packages and publish');
	const runAt = yaml.indexOf('        run: |\n', at);
	assert.ok(at > 0 && runAt > at, 'the publish step was not found');
	const block = yaml.slice(runAt + '        run: |\n'.length).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-step-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nprintf \'%s\' "$2" > "$RENDER_OUT"\n', { mode: 0o755 });
	const out = path.join(dir, 'step.js');
	execFileSync('bash', ['-c', block], { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, RENDER_OUT: out, TAG: 'alpha' } });
	renderedStep = fs.readFileSync(out, 'utf8');
	return renderedStep;
}

// Runs the step with dry-run on in `dir`, after bumping every candidate's version as
// `changeset version --snapshot` would. Returns the names it would publish, sorted.
function stepPublishes(t, dir, candidates, env) {
	const pre = {};
	for (const c of candidates) {
		const file = path.join(dir, c.path, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
		pre[c.name] = { version: '1.0.0', path: c.path };
		fs.writeFileSync(file, JSON.stringify({ ...pkg, version: c.newVersion }));
	}
	const preFile = path.join(dir, 'pre-versions.json');
	fs.writeFileSync(preFile, JSON.stringify(pre));
	// The step reads the versions from a fixed /tmp path; point this run at its own file.
	const fixed = "'/tmp/pre-versions.json'";
	const script = stepScript(t);
	assert.equal(script.split(fixed).length, 2, 'the step reads pre-versions.json once');
	const stdout = execFileSync(process.execPath, ['-e', script.replace(fixed, JSON.stringify(preFile))], {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, NPM_TAG: 'alpha', PM: 'npm', SKIP_UNCHANGED: 'true', DRY_RUN: 'true', BUILD_DEPS: 'false', BUILD_SCRIPT: 'build', EVENT_NAME: 'push', ...env },
	});
	const lines = stdout.split('\n');
	const from = lines.findIndex((l) => l.includes('[dry-run] would publish'));
	assert.ok(from >= 0, 'no dry-run report in: ' + stdout);
	return lines.slice(from + 1).map((l) => l.trim()).filter(Boolean).sort();
}

test('the step reads its base from content-base-sha before github.event.before', () => {
	assert.ok(yaml.includes('BASE_SHA: ${{ inputs.content-base-sha || github.event.before }}'), 'BASE_SHA no longer prefers the input');
	assert.match(yaml, /content-base-sha:\n\s+required: false\n\s+type: string\n\s+default: ''/);
});

test('three pushes, the middle run cancelled: against the previous push, the middle package is skipped', (t) => {
	// The defect, kept as a test so the next one shows what the input changes.
	const { dir, pushes, candidates } = threePushes(t);
	assert.deepEqual(stepPublishes(t, dir, candidates, { BASE_SHA: pushes[1], HEAD_SHA: pushes[2] }), ['c']);
});

test('three pushes, the middle run cancelled: against the last push that published, the middle package publishes', (t) => {
	const { dir, pushes, candidates } = threePushes(t);
	assert.deepEqual(stepPublishes(t, dir, candidates, { BASE_SHA: pushes[0], HEAD_SHA: pushes[2] }), ['b', 'c']);
});

test('no base means every version-moved package publishes: all zeros, an empty value, a manual run', (t) => {
	const { dir, pushes, candidates } = threePushes(t);
	for (const env of [{ BASE_SHA: '0'.repeat(40) }, { BASE_SHA: '' }, { BASE_SHA: pushes[1], EVENT_NAME: 'workflow_dispatch' }]) {
		assert.deepEqual(stepPublishes(t, dir, candidates, { HEAD_SHA: pushes[2], ...env }), ['a', 'b', 'c'], JSON.stringify(env));
	}
});

test('a base that is not an ancestor of HEAD means no base', (t) => {
	const { dir, git, start, pushes, candidates } = threePushes(t);
	git('checkout', '-q', '-b', 'side', start);
	git('commit', '-q', '--allow-empty', '-m', 'elsewhere');
	const side = git('rev-parse', 'HEAD');
	git('checkout', '-q', 'trunk');
	assert.equal(loadGateIn(dir).resolveBase('push', side, pushes[2]), null);
	assert.deepEqual(stepPublishes(t, dir, candidates, { BASE_SHA: side, HEAD_SHA: pushes[2] }), ['a', 'b', 'c']);
});

test('a base that is not a commit id is never passed to a shell, and means no base', (t) => {
	const { dir, pushes, candidates } = threePushes(t);
	const marker = path.join(dir, 'injected');
	const bad = ['HEAD; touch ' + marker, '$(touch ' + marker + ')', 'develop', 'abc123', pushes[0] + ' --output=' + marker, pushes[0] + '\n'];
	for (const value of bad) {
		const calls = [];
		assert.equal(loadGateIn(dir, calls).resolveBase('push', value, pushes[2]), null, value);
		assert.deepEqual(calls, [], 'a command ran for ' + value);
	}
	// And through the step itself.
	assert.deepEqual(stepPublishes(t, dir, candidates, { BASE_SHA: bad[0], HEAD_SHA: pushes[2] }), ['a', 'b', 'c']);
	assert.equal(fs.existsSync(marker), false);
});

test('existing behaviour kept: an event other than push has no base, whatever the input', (t) => {
	const { dir, pushes } = threePushes(t);
	assert.equal(loadGateIn(dir).resolveBase('workflow_dispatch', pushes[0], pushes[2]), null);
});

test('a full commit id that is an ancestor is the base, in either hash length', (t) => {
	const { dir, pushes } = threePushes(t);
	assert.equal(loadGateIn(dir).resolveBase('push', pushes[0], pushes[2]), pushes[0]);
	// A sha256 repository's ids are 64 hex digits; the format check must let them reach git.
	const calls = [];
	loadGateIn(dir, calls).resolveBase('push', 'a'.repeat(64), pushes[2]);
	assert.equal(calls.length, 1);
});
