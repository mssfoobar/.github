// Tests .github/actions/claude-code-cache: the key derivation and the version
// check, run as bash exactly as the action runs them (read out of the YAML
// between the `# ---- keys` / `# ---- verify` markers), against fixtures.
//
// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const yaml = fs.readFileSync(new URL('../.github/actions/claude-code-cache/action.yml', import.meta.url), 'utf8');
function block(name) {
	const start = yaml.indexOf(`# ---- ${name}\n`);
	const end = yaml.indexOf(`# ---- end ${name}\n`);
	assert.ok(start > 0 && end > start, `${name} markers not found`);
	return yaml.slice(start, end).replace(/^ {8}/gm, '');
}
const REF = 'e4a6faad497d33dbc7144135c75e41f82f0bf6c0';

function tmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cache-'));
}
function run(script, env) {
	const dir = tmp();
	const out = path.join(dir, 'out');
	const genv = path.join(dir, 'env');
	fs.writeFileSync(out, '');
	fs.writeFileSync(genv, '');
	const stdout = execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: out, GITHUB_ENV: genv, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ...env }, encoding: 'utf8' });
	const outputs = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
	return { stdout, outputs, env: fs.readFileSync(genv, 'utf8') };
}
function actionDir({ claude = '2.1.305', bun = '1.3.14', lock = '{"lockfileVersion":1}' } = {}) {
	const d = tmp();
	fs.mkdirSync(path.join(d, 'src/entrypoints'), { recursive: true });
	fs.writeFileSync(path.join(d, 'action.yml'), `runs:\n  steps:\n    - uses: oven-sh/setup-bun@x\n      with:\n        bun-version: ${bun}\n`);
	if (claude !== null) fs.writeFileSync(path.join(d, 'src/entrypoints/run.ts'), `async function installClaudeCode() {\n  const claudeCodeVersion = "${claude}";\n}\n`);
	if (lock !== null) fs.writeFileSync(path.join(d, 'bun.lock'), lock);
	fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x"}');
	return d;
}

test('keys: versions come from the action checkout, keyed by OS and arch, at literal ~ paths', () => {
	const { outputs } = run(block('keys'), { REF, ACTION_DIR: actionDir() });
	assert.equal(outputs.ok, 'true');
	assert.equal(outputs['claude-version'], '2.1.305');
	assert.equal(outputs['bun-version'], '1.3.14');
	assert.equal(outputs['claude-key'], 'claude-code-2.1.305-Linux-X64');
	assert.equal(outputs['bun-key'], 'bun-1.3.14-Linux-X64');
	assert.match(outputs['deps-key'], /^claude-code-action-deps-[0-9a-f]{16}-Linux-X64$/);
	assert.equal(outputs['claude-dir'], '~/.cache/claude-code-cache/claude');
	assert.equal(outputs['bun-dir'], '~/.cache/claude-code-cache/bun');
	assert.equal(outputs['deps-dir'], '~/.cache/claude-code-cache/bun-install');
	assert.equal(outputs.root, `${process.env.HOME}/.cache/claude-code-cache`);
});

test('keys: another lockfile is another dependency key', () => {
	const a = run(block('keys'), { REF, ACTION_DIR: actionDir() }).outputs['deps-key'];
	const b = run(block('keys'), { REF, ACTION_DIR: actionDir({ lock: '{"lockfileVersion":2}' }) }).outputs['deps-key'];
	assert.notEqual(a, b);
});

test('keys: the default checkout is the runner\'s copy of the action at that SHA', () => {
	const ws = tmp();
	const d = path.join(ws, '_actions/anthropics/claude-code-action', REF);
	fs.mkdirSync(path.dirname(d), { recursive: true });
	fs.renameSync(actionDir({ claude: '2.1.220' }), d);
	fs.mkdirSync(path.join(ws, 'repo'));
	const { outputs } = run(block('keys'), { REF, ACTION_DIR: '', RUNNER_WORKSPACE: path.join(ws, 'repo') });
	assert.equal(outputs['claude-version'], '2.1.220');
});

for (const [name, env] of [
	['a short ref', { REF: 'e4a6faa' }],
	['a branch name', { REF: 'main' }],
	['no checkout', { ACTION_DIR: '/nonexistent' }],
	['no run.ts', { ACTION_DIR: actionDir({ claude: null }) }],
	['a malformed Claude version', { ACTION_DIR: actionDir({ claude: 'latest' }) }],
	['a malformed Bun version', { ACTION_DIR: actionDir({ bun: '1.3' }) }],
	['no bun.lock', { ACTION_DIR: actionDir({ lock: null }) }],
]) {
	test(`keys fail open on ${name}: ok=false, no keys, exit 0`, () => {
		const { stdout, outputs } = run(block('keys'), { REF, ACTION_DIR: actionDir(), ...env });
		assert.equal(outputs.ok, 'false');
		assert.equal(outputs['claude-key'], undefined);
		assert.match(stdout, /::warning title=Claude Code cache::/);
	});
}

// A fake publisher: Claude Code's manifest and Bun's SHASUMS256.txt, served
// from file:// URLs, listing the checksums of whatever the test passes.
import crypto from 'node:crypto';
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fakeExe(p, out) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, `#!/bin/sh\necho '${out}'\n`, { mode: 0o755 });
}
function home({ claude, bun, deps = false, claudeSum, bunSum } = {}) {
	const h = tmp();
	const root = path.join(h, '.cache/claude-code-cache');
	const pub = tmp();
	if (claude !== undefined) fakeExe(path.join(root, 'claude/claude'), claude);
	if (bun !== undefined) {
		const stage = tmp();
		fakeExe(path.join(stage, 'bun-linux-x64/bun'), bun);
		fs.mkdirSync(path.join(root, 'bun'), { recursive: true });
		execFileSync('zip', ['-qr', path.join(root, 'bun/bun-linux-x64.zip'), 'bun-linux-x64'], { cwd: stage });
	}
	if (deps) fs.mkdirSync(path.join(root, 'bun-install'), { recursive: true });
	const c = claudeSum ?? (claude !== undefined ? sha(path.join(root, 'claude/claude')) : 'f'.repeat(64));
	fs.mkdirSync(path.join(pub, 'claude/2.1.305'), { recursive: true });
	fs.writeFileSync(path.join(pub, 'claude/2.1.305/manifest.json'), JSON.stringify({ version: '2.1.305', platforms: { 'linux-x64-musl': { checksum: 'e'.repeat(64) }, 'linux-x64': { checksum: c, size: 1 }, 'darwin-arm64': { checksum: 'd'.repeat(64) } } }, null, 2));
	const b = bunSum ?? (bun !== undefined ? sha(path.join(root, 'bun/bun-linux-x64.zip')) : 'f'.repeat(64));
	fs.mkdirSync(path.join(pub, 'bun/bun-v1.3.14'), { recursive: true });
	fs.writeFileSync(path.join(pub, 'bun/bun-v1.3.14/SHASUMS256.txt'), `${'a'.repeat(64)}  bun-linux-x64-baseline.zip\n${b}  bun-linux-x64.zip\n${'c'.repeat(64)}  bun-linux-x64-musl.zip\n`);
	return { h, root, pub };
}
// The action pins its publishers' URLs, https only; the test points its own
// copy of the script at the fake publisher, and checks nothing else differs.
const PUBLISHERS = ['https://downloads.claude.ai/claude-code-releases', 'https://github.com/oven-sh/bun/releases/download'];
function verifyAt(pub, claude = `file://${pub}/claude`, bun = `file://${pub}/bun`) {
	const b = block('verify');
	for (const u of PUBLISHERS) assert.equal(b.split(u).length, 2, `${u} appears once`);
	return b.replace(PUBLISHERS[0], claude).replace(PUBLISHERS[1], bun).replaceAll('--proto =https ', '');
}
const verify = ({ h, pub }, env, script = verifyAt(pub)) =>
	run(script, {
		HOME: h,
		CLAUDE_VERSION: '2.1.305',
		CLAUDE_PLATFORM: 'linux-x64',
		BUN_VERSION: '1.3.14',
		BUN_ZIP: 'bun-linux-x64.zip',
		CLAUDE_HIT: '',
		BUN_HIT: '',
		DEPS_HIT: '',
		...env,
	});
const HITS = { CLAUDE_HIT: 'true', BUN_HIT: 'true' };
// A curl that fails every request, so the real script runs offline.
function fakeCurl() {
	const d = tmp();
	fs.writeFileSync(path.join(d, 'curl'), '#!/bin/sh\nexit 6\n', { mode: 0o755 });
	return d;
}

test('keys: the publishers\' platform names for this runner', () => {
	const { outputs } = run(block('keys'), { REF, ACTION_DIR: actionDir() });
	assert.equal(outputs['claude-platform'], 'linux-x64');
	assert.equal(outputs['bun-zip'], 'bun-linux-x64.zip');
	const arm = run(block('keys'), { REF, ACTION_DIR: actionDir(), RUNNER_ARCH: 'ARM64' }).outputs;
	assert.equal(arm['claude-platform'], 'linux-arm64');
	assert.equal(arm['bun-zip'], 'bun-linux-aarch64.zip');
	assert.equal(run(block('keys'), { REF, ACTION_DIR: actionDir(), RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64' }).outputs.ok, 'false');
});

test('verify: entries matching their published checksums and versions are used, and the install cache is exported', () => {
	const f = home({ claude: '2.1.305 (Claude Code)', bun: '1.3.14', deps: true });
	const r = verify(f, { ...HITS, DEPS_HIT: 'true' });
	assert.equal(r.outputs['claude-path'], `${f.root}/claude/claude`);
	assert.equal(r.outputs['bun-path'], `${f.root}/bun/bin/bun`);
	assert.equal(r.env, `BUN_INSTALL_CACHE_DIR=${f.root}/bun-install\n`);
});

for (const [name, opts, claudeOk, bunOk] of [
	['a Claude binary that does not match its published checksum', { claudeSum: '0'.repeat(64) }, false, true],
	['a Bun archive that does not match its published checksum', { bunSum: '0'.repeat(64) }, true, false],
	['another Claude version, checksum matching', { claude: '2.1.220 (Claude Code)' }, false, true],
	['a Claude version with the pinned one as a prefix', { claude: '2.1.3050 (Claude Code)' }, false, true],
	['another Bun version, checksum matching', { bun: '1.3.13' }, true, false],
	['binaries that print nothing', { claude: '', bun: '' }, false, false],
]) {
	test(`verify falls back on ${name}: that path stays empty, with a warning`, () => {
		const f = home({ claude: '2.1.305 (Claude Code)', bun: '1.3.14', ...opts });
		const r = verify(f, HITS);
		assert.equal(r.outputs['claude-path'], claudeOk ? `${f.root}/claude/claude` : undefined);
		assert.equal(r.outputs['bun-path'], bunOk ? `${f.root}/bun/bin/bun` : undefined);
		assert.match(r.stdout, /::warning title=Claude Code cache::.*installs it as usual/);
	});
}

for (const [name, opts] of [
	['does not match its checksum', { claudeSum: '0'.repeat(64), bunSum: '0'.repeat(64) }],
	['has no readable checksum', { unreadable: true }],
]) {
	test(`verify never runs a restored binary that ${name}`, () => {
		const f = home({ ...opts });
		const marker = path.join(f.h, 'ran');
		// A planted binary that, if run, writes the job's outputs and environment.
		for (const p of [path.join(f.root, 'claude/claude')]) {
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\necho "claude-path=/tmp/evil" >> "$GITHUB_OUTPUT"\necho "NODE_OPTIONS=--require /tmp/evil.js" >> "$GITHUB_ENV"\necho '2.1.305 (Claude Code)'\n`, { mode: 0o755 });
		}
		const script = opts.unreadable ? verifyAt(f.pub, 'file:///nonexistent', 'file:///nonexistent') : verifyAt(f.pub);
		const r = verify(f, { CLAUDE_HIT: 'true', BUN_HIT: '' }, script);
		assert.equal(fs.existsSync(marker), false, 'the planted binary ran');
		assert.deepEqual(r.outputs, {});
		assert.equal(r.env, '');
	});
}

test('verify falls back when the published checksums cannot be read', () => {
	const f = home({ claude: '2.1.305 (Claude Code)', bun: '1.3.14' });
	const r = verify(f, HITS, verifyAt(f.pub, 'file:///nonexistent', 'file:///nonexistent'));
	assert.deepEqual(r.outputs, {});
	assert.match(r.stdout, /could not read Claude Code 2\.1\.305's published checksum/);
	assert.match(r.stdout, /could not read Bun 1\.3\.14's published checksum/);
});

test('verify reads the checksum of this platform, not a neighbour\'s', () => {
	const f = home({ claude: '2.1.305 (Claude Code)', bun: '1.3.14' });
	const r = verify(f, { ...HITS, CLAUDE_PLATFORM: 'linux-x64-musl', BUN_ZIP: 'bun-linux-x64-musl.zip' });
	assert.deepEqual(r.outputs, {});
});

test('verify: a hit whose files are missing falls back, with a warning', () => {
	const f = home();
	const r = verify(f, HITS);
	assert.deepEqual(r.outputs, {});
	assert.match(r.stdout, /::warning title=Claude Code cache::the cached Claude Code does not match/);
	assert.match(r.stdout, /::warning title=Claude Code cache::the cached Bun does not match/);
});

test('keys: no RUNNER_WORKSPACE and no action-dir fails open', () => {
	const { outputs } = run(block('keys'), { REF, ACTION_DIR: '' });
	assert.equal(outputs.ok, 'false');
	assert.equal(outputs['claude-key'], undefined);
});

test('keys: another Bun version is another dependency key', () => {
	const a = run(block('keys'), { REF, ACTION_DIR: actionDir() }).outputs['deps-key'];
	const b = run(block('keys'), { REF, ACTION_DIR: actionDir({ bun: '1.3.15' }) }).outputs['deps-key'];
	assert.notEqual(a, b);
});

test('verify: misses use nothing and export nothing, even with verified files on disk', () => {
	const f = home({ claude: '2.1.305 (Claude Code)', bun: '1.3.14', deps: true });
	const r = verify(f, { CLAUDE_HIT: 'false', BUN_HIT: '' });
	assert.deepEqual(r.outputs, {});
	assert.equal(r.env, '');
});

// The structure: read only, exact keys, restores only with a bucket and
// credentials, never fails the job.
const steps = yaml.split(/\n(?= {4}- )/).slice(1);
const restores = steps.filter((s) => /uses: runs-on\/cache/.test(s));
test('the action restores three entries and saves none', () => {
	assert.equal(restores.length, 3);
	for (const s of restores) assert.match(s, /uses: runs-on\/cache\/restore@[0-9a-f]{40} /);
	assert.doesNotMatch(yaml, /uses:\s*runs-on\/cache(?:\/save)?@/, 'a save, or the combined action, which also saves');
});
test('each restore takes an exact key, step-scoped credentials and the bucket, and cannot fail the job', () => {
	for (const s of restores) {
		assert.doesNotMatch(s, /restore-keys/);
		assert.match(s, /continue-on-error: true/);
		assert.match(s, /if: inputs\.restore == 'true' && inputs\.bucket != '' && inputs\.aws-access-key-id != '' && steps\.keys\.outputs\.ok == 'true'/);
		for (const k of ['RUNS_ON_S3_BUCKET_CACHE: ${{ inputs.bucket }}', 'AWS_ACCESS_KEY_ID: ${{ inputs.aws-access-key-id }}', 'AWS_SECRET_ACCESS_KEY: ${{ inputs.aws-secret-access-key }}', 'AWS_SESSION_TOKEN: ${{ inputs.aws-session-token }}']) assert.ok(s.includes(k), `missing ${k}`);
	}
});
test('the publishers are fixed https URLs, never read from the environment', () => {
	const b = block('verify');
	for (const u of PUBLISHERS) assert.ok(b.includes(`=${u}\n`), `${u} is assigned literally`);
	assert.doesNotMatch(b, /\$\{[A-Z_]*RELEASES/);
	assert.equal((b.match(/curl /g) ?? []).length, (b.match(/curl -fsSL --proto =https /g) ?? []).length, 'every curl is https only');
});

test('an environment override cannot redirect the checksum source', () => {
	const f = home({ claude: '2.1.305 (Claude Code)', bun: '1.3.14', claudeSum: '0'.repeat(64), bunSum: '0'.repeat(64) });
	// The real script, a poisoned job environment, and no network: the fake
	// publisher would vouch for anything, but the script never asks it.
	const r = verify(f, { ...HITS, CLAUDE_RELEASES: `file://${f.pub}/claude`, BUN_RELEASES: `file://${f.pub}/bun`, PATH: `${fakeCurl()}:${process.env.PATH}` }, block('verify'));
	assert.deepEqual(r.outputs, {});
});

test('no step of the action can fail the job', () => {
	assert.equal(steps.length, 5);
	for (const s of steps) assert.match(s, /\n {6}continue-on-error: true\n/, s.split('\n')[0]);
});
test('nothing writes credentials or the bucket to the job environment', () => {
	assert.doesNotMatch(yaml, /(AWS_|RUNS_ON_)[A-Z_]*=.*>>\s*"?\$GITHUB_ENV/);
});
