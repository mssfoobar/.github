// Tests the release planning in .github/workflows/monorepo-changeset-release.yml.
//
// The planner is inline JavaScript in a quoted heredoc (`node <<'JS'`), because
// a reusable workflow runs in the caller's checkout and cannot load a script
// file from this repository. The heredoc is quoted, so bash passes it through
// unchanged; the test reads the helpers out of the YAML between the
// `pure helpers` and `main` markers. What runs here is what runs in CI.
//
// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const yaml = fs.readFileSync(new URL('../.github/workflows/monorepo-changeset-release.yml', import.meta.url), 'utf8');
const start = yaml.indexOf('// ---- pure helpers');
const end = yaml.indexOf('// ---- main');
assert.ok(start > 0 && end > start, 'helper markers not found in monorepo-changeset-release.yml');
const helpers = yaml.slice(start, end);

const names = ['changedPackages', 'releaseLabel', 'changelogEntry'];
const exported = names.map((n) => n + ': typeof ' + n + " === 'function' ? " + n + ' : undefined').join(', ');
const h = new Function(helpers + '\nreturn { ' + exported + ' };')();

// mssfoobar/msr's workspaces, in its root package.json order.
const msrPre = {
	'@mssfoobar/msr-web': { version: '2.0.0', path: 'web' },
	'@mssfoobar/msr-app': { version: '1.5.1', path: 'app' },
};

test('each changed package gets its own tag and title, with its own version', () => {
	// The 2026-10-01 release: both packages changed. The old workflow named the
	// whole release after the first workspace's version (v2.0.1).
	const current = [
		{ path: 'web', name: '@mssfoobar/msr-web', version: '2.0.1' },
		{ path: 'app', name: '@mssfoobar/msr-app', version: '1.5.2' },
	];
	assert.deepEqual(
		h.changedPackages(msrPre, current).map(({ tag, title }) => ({ tag, title })),
		[
			{ tag: 'msr-web/v2.0.1', title: '@mssfoobar/msr-web v2.0.1' },
			{ tag: 'msr-app/v1.5.2', title: '@mssfoobar/msr-app v1.5.2' },
		],
	);
});

test('only the packages whose version changed are released', () => {
	// The queued msr-app 2.0.0: msr-web unchanged.
	const current = [
		{ path: 'web', name: '@mssfoobar/msr-web', version: '2.0.0' },
		{ path: 'app', name: '@mssfoobar/msr-app', version: '2.0.0' },
	];
	const changed = h.changedPackages(msrPre, current);
	assert.equal(changed.length, 1);
	assert.deepEqual(changed[0], {
		name: '@mssfoobar/msr-app',
		path: 'app',
		oldVersion: '1.5.1',
		newVersion: '2.0.0',
		tag: 'msr-app/v2.0.0',
		title: '@mssfoobar/msr-app v2.0.0',
	});
});

test('nothing changed: no packages', () => {
	const current = [
		{ path: 'web', name: '@mssfoobar/msr-web', version: '2.0.0' },
		{ path: 'app', name: '@mssfoobar/msr-app', version: '1.5.1' },
	];
	assert.deepEqual(h.changedPackages(msrPre, current), []);
});

test('an unscoped package keeps its name in the tag and title', () => {
	const changed = h.changedPackages({ 'msr-tools': { version: '0.1.0', path: 'tools' } }, [
		{ path: 'tools', name: 'msr-tools', version: '0.2.0' },
	]);
	assert.deepEqual(
		changed.map(({ tag, title }) => ({ tag, title })),
		[{ tag: 'msr-tools/v0.2.0', title: 'msr-tools v0.2.0' }],
	);
});

test('a prerelease bump is released under its full version', () => {
	const changed = h.changedPackages(msrPre, [{ path: 'app', name: '@mssfoobar/msr-app', version: '1.6.0-rc.0' }]);
	assert.deepEqual(
		changed.map(({ tag, title }) => ({ tag, title })),
		[{ tag: 'msr-app/v1.6.0-rc.0', title: '@mssfoobar/msr-app v1.6.0-rc.0' }],
	);
});

test('a package with no version before the bump is not released (unchanged behaviour)', () => {
	const changed = h.changedPackages(msrPre, [{ path: 'new', name: '@mssfoobar/msr-new', version: '0.0.1' }]);
	assert.deepEqual(changed, []);
});

test('the release label names every released package and version', () => {
	const label = h.releaseLabel([
		{ name: '@mssfoobar/msr-web', newVersion: '2.0.1' },
		{ name: '@mssfoobar/msr-app', newVersion: '1.5.2' },
	]);
	assert.equal(label, '@mssfoobar/msr-web@v2.0.1, @mssfoobar/msr-app@v1.5.2');
	assert.equal(h.releaseLabel([{ name: '@mssfoobar/msr-app', newVersion: '2.0.0' }]), '@mssfoobar/msr-app@v2.0.0');
});

const changelog = [
	'# @mssfoobar/msr-app',
	'',
	'## 2.0.0',
	'',
	'### Major Changes',
	'',
	'- abc1234: Only a platform administrator changes the replay settings.',
	'',
	'## 1.5.2',
	'',
	'### Patch Changes',
	'',
	'- 6b51305: Stop the daily maintenance fold losing replay history.',
	'',
].join('\n');

test('the changelog entry is the version section, without its heading', () => {
	assert.equal(
		h.changelogEntry(changelog, '2.0.0'),
		'### Major Changes\n\n- abc1234: Only a platform administrator changes the replay settings.',
	);
	assert.equal(h.changelogEntry(changelog, '1.5.2'), '### Patch Changes\n\n- 6b51305: Stop the daily maintenance fold losing replay history.');
});

test('a version is matched literally, not as a pattern', () => {
	// An unescaped "." matches any character, so 2.0.0 would match "## 2x0x0".
	assert.equal(h.changelogEntry('## 2x0x0\n\nwrong\n', '2.0.0'), null);
	assert.equal(h.changelogEntry('## 2.0.0-rc.1\n\nrc notes\n', '2.0.0-rc.1'), 'rc notes');
	// 1.5.2 must not match the 1.5.20 heading.
	assert.equal(h.changelogEntry('## 1.5.20\n\nlater\n\n## 1.5.2\n\nright\n', '1.5.2'), 'right');
});

test('a heading with trailing text still matches; an rc heading does not match the final version', () => {
	assert.equal(h.changelogEntry('## 1.0.0 (2026-01-01)\n\nnotes\n', '1.0.0'), 'notes');
	assert.equal(h.changelogEntry('## 1.0.0-rc.1\n\nrc\n', '1.0.0'), null);
	assert.equal(h.changelogEntry('## 1.0.0-rc.1\n\nrc\n\n## 1.0.0\n\nfinal\n', '1.0.0'), 'final');
});

test('a CRLF changelog reads the same as an LF one', () => {
	assert.equal(h.changelogEntry('## 1.0.0\r\n\r\n- notes\r\n\r\n## 0.9.0\r\n\r\nold\r\n', '1.0.0'), '- notes');
});

test('an empty section is an empty entry, which the caller replaces with a placeholder', () => {
	assert.equal(h.changelogEntry('## 1.0.0\n\n## 0.9.0\n\nold\n', '1.0.0'), '');
});

test('no section for the version: no entry', () => {
	assert.equal(h.changelogEntry(changelog, '9.9.9'), null);
	assert.equal(h.changelogEntry('', '1.0.0'), null);
});

// The `main` section, run as the step runs it, in a temp checkout. The later
// bash steps read /tmp/changed.json's tag, title and notesFile and the `label`
// output, so this pins that contract.
const mainEnd = yaml.indexOf('\n                  JS\n', end);
assert.ok(mainEnd > end, 'heredoc terminator not found after the main marker');
const mainSection = yaml.slice(end, mainEnd);

function runPlan({ workspaces, pre }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcr-'));
	try {
		const tmp = path.join(dir, 'tmp');
		const repo = path.join(dir, 'repo');
		fs.mkdirSync(tmp);
		fs.mkdirSync(repo);
		fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ workspaces: workspaces.map((w) => w.path) }));
		for (const w of workspaces) {
			fs.mkdirSync(path.join(repo, w.path));
			fs.writeFileSync(path.join(repo, w.path, 'package.json'), JSON.stringify({ name: w.name, version: w.version }));
			if (w.changelog !== undefined) fs.writeFileSync(path.join(repo, w.path, 'CHANGELOG.md'), w.changelog);
		}
		fs.writeFileSync(path.join(tmp, 'pre-versions.json'), JSON.stringify(pre));
		const out = path.join(dir, 'github-output');
		fs.writeFileSync(out, '');
		const script = ("const fs = require('fs');\n" + helpers + mainSection).replaceAll('/tmp/', tmp + '/');
		execFileSync(process.execPath, ['-e', script], { cwd: repo, env: { ...process.env, GITHUB_OUTPUT: out }, stdio: 'pipe' });
		const outputs = Object.fromEntries(
			fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
		);
		const changedPath = path.join(tmp, 'changed.json');
		const changed = fs.existsSync(changedPath) ? JSON.parse(fs.readFileSync(changedPath, 'utf8')) : null;
		const notes = changed ? changed.map((c) => fs.readFileSync(c.notesFile, 'utf8')) : null;
		return { outputs, changed, notes };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('main: writes the outputs, changed.json and one notes file per released package', () => {
	const { outputs, changed, notes } = runPlan({
		workspaces: [
			{ path: 'web', name: '@mssfoobar/msr-web', version: '2.0.1' },
			{ path: 'app', name: '@mssfoobar/msr-app', version: '2.0.0', changelog: '# @mssfoobar/msr-app\n\n## 2.0.0\n\n- new\n\n## 1.5.2\n\n- old\n' },
		],
		pre: { '@mssfoobar/msr-web': { version: '2.0.0', path: 'web' }, '@mssfoobar/msr-app': { version: '1.5.2', path: 'app' } },
	});
	assert.equal(outputs.has_changes, 'true');
	assert.equal(outputs.label, '@mssfoobar/msr-web@v2.0.1, @mssfoobar/msr-app@v2.0.0');
	assert.deepEqual(
		changed.map(({ tag, title }) => ({ tag, title })),
		[
			{ tag: 'msr-web/v2.0.1', title: '@mssfoobar/msr-web v2.0.1' },
			{ tag: 'msr-app/v2.0.0', title: '@mssfoobar/msr-app v2.0.0' },
		],
	);
	// msr-web has no CHANGELOG.md: placeholder notes, not an empty Release.
	assert.deepEqual(notes, ['Release @mssfoobar/msr-web v2.0.1.\n', '- new\n']);
});

test('main: nothing changed sets has_changes=false and writes no changed.json', () => {
	const { outputs, changed } = runPlan({
		workspaces: [{ path: 'app', name: '@mssfoobar/msr-app', version: '1.5.2' }],
		pre: { '@mssfoobar/msr-app': { version: '1.5.2', path: 'app' } },
	});
	assert.deepEqual(outputs, { has_changes: 'false' });
	assert.equal(changed, null);
});

test('the bash steps read the fields main writes', () => {
	assert.ok(yaml.includes(`jq -r '.[].tag' /tmp/changed.json`), 'tag step no longer reads .tag');
	assert.ok(yaml.includes(`jq -r '.[] | [.tag, .title, .notesFile] | @tsv' /tmp/changed.json`), 'release step no longer reads .tag, .title, .notesFile');
	assert.ok(yaml.includes('LABEL: ${{ steps.changes.outputs.label }}'), 'label output no longer consumed');
});
