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

test('no section for the version: no entry', () => {
	assert.equal(h.changelogEntry(changelog, '9.9.9'), null);
	assert.equal(h.changelogEntry('', '1.0.0'), null);
});
