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
	const stdout = execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_ENV: genv, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ...env }, encoding: 'utf8' });
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

function home({ claude, bun, deps = false } = {}) {
	const h = tmp();
	const root = path.join(h, '.cache/claude-code-cache');
	const fake = (p, v) => {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, `#!/bin/sh\necho '${v}'\n`, { mode: 0o755 });
	};
	if (claude) fake(path.join(root, 'claude/claude'), claude);
	if (bun) fake(path.join(root, 'bun/bun'), bun);
	if (deps) fs.mkdirSync(path.join(root, 'bun-install'), { recursive: true });
	return { h, root };
}
const verify = (h, env) => run(block('verify'), { HOME: h, CLAUDE_VERSION: '2.1.305', BUN_VERSION: '1.3.14', CLAUDE_HIT: '', BUN_HIT: '', DEPS_HIT: '', ...env });

test('verify: hits whose binaries report the pinned versions are used, and the install cache is exported', () => {
	const { h, root } = home({ claude: '2.1.305 (Claude Code)', bun: '1.3.14', deps: true });
	const r = verify(h, { CLAUDE_HIT: 'true', BUN_HIT: 'true', DEPS_HIT: 'true' });
	assert.equal(r.outputs['claude-path'], `${root}/claude/claude`);
	assert.equal(r.outputs['bun-path'], `${root}/bun/bun`);
	assert.equal(r.env, `BUN_INSTALL_CACHE_DIR=${root}/bun-install\n`);
});

for (const [name, claude, bun] of [
	['another Claude version', '2.1.220 (Claude Code)', '1.3.14'],
	['a Claude version with the pinned one as a prefix', '2.1.3050 (Claude Code)', '1.3.14'],
	['another Bun version', '2.1.305 (Claude Code)', '1.3.13'],
	['a binary that prints nothing', '', ''],
]) {
	test(`verify falls back on ${name}: that path stays empty, with a warning`, () => {
		const { h, root } = home({ claude, bun });
		const r = verify(h, { CLAUDE_HIT: 'true', BUN_HIT: 'true' });
		const claudeOk = claude.startsWith('2.1.305 ');
		assert.equal(r.outputs['claude-path'], claudeOk ? `${root}/claude/claude` : undefined);
		assert.equal(r.outputs['bun-path'], bun === '1.3.14' ? `${root}/bun/bun` : undefined);
		assert.match(r.stdout, /::warning title=Claude Code cache::.*installs it as usual/);
	});
}

test('verify: a hit whose binary is missing or not executable falls back', () => {
	const { h } = home();
	const r = verify(h, { CLAUDE_HIT: 'true', BUN_HIT: 'true' });
	assert.equal(r.outputs['claude-path'], undefined);
	assert.equal(r.outputs['bun-path'], undefined);
});

test('verify: misses use nothing and export nothing, even with binaries on disk', () => {
	const { h } = home({ claude: '2.1.305 (Claude Code)', bun: '1.3.14', deps: true });
	const r = verify(h, { CLAUDE_HIT: 'false', BUN_HIT: '' });
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
test('no step of the action can fail the job', () => {
	assert.equal(steps.length, 5);
	for (const s of steps) assert.match(s, /\n {6}continue-on-error: true\n/, s.split('\n')[0]);
});
test('nothing writes credentials or the bucket to the job environment', () => {
	assert.doesNotMatch(yaml, /(AWS_|RUNS_ON_)[A-Z_]*=.*>>\s*"?\$GITHUB_ENV/);
});
