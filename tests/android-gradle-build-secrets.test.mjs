// Tests the "Export secrets" step in .github/workflows/android-gradle-build.yml.
//
// The step is inline bash, so the test reads its `run: |` block out of the
// YAML and runs it with bash, the way the runner does. What runs here is what
// runs in CI. It needs bash, jq, openssl and base64, as the runner has.
//
// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const yaml = fs.readFileSync(new URL('../.github/workflows/android-gradle-build.yml', import.meta.url), 'utf8');

function exportSecretsScript() {
	const lines = yaml.split(/\r?\n/);
	const step = lines.findIndex((l) => /^\s*- name: Export secrets\s*$/.test(l));
	assert.ok(step >= 0, 'Export secrets step not found in android-gradle-build.yml');
	const run = lines.findIndex((l, i) => i > step && /^\s*run: \|\s*$/.test(l));
	assert.ok(run > step, "Export secrets step has no 'run: |' block");
	const runIndent = lines[run].search(/\S/);
	const body = [];
	for (const line of lines.slice(run + 1)) {
		if (line.trim() !== '' && line.search(/\S/) <= runIndent) break;
		body.push(line);
	}
	const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
	return body.map((l) => l.slice(indent)).join('\n');
}

const script = exportSecretsScript();

function exportSecrets({ secrets, envSecrets = '', decodeFiles = '' }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-secrets-'));
	const githubEnv = path.join(dir, 'github_env');
	fs.writeFileSync(githubEnv, '');
	const result = spawnSync('bash', ['-e', '-c', script], {
		cwd: dir,
		encoding: 'utf8',
		env: {
			...process.env,
			GITHUB_ENV: githubEnv,
			SECRETS_JSON: JSON.stringify(secrets),
			ENV_SECRETS: envSecrets,
			DECODE_FILES: decodeFiles,
			ENVIRONMENT: 'dev',
		},
	});
	return { ...result, dir, githubEnv: fs.readFileSync(githubEnv, 'utf8') };
}

// Parses GITHUB_ENV the way the runner does, failing on a value left without its delimiter.
function parseGithubEnv(text) {
	const env = {};
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === '') continue;
		const m = /^([^<=]+)<<(.+)$/.exec(lines[i]);
		assert.ok(m, `not a NAME<<DELIMITER line: ${lines[i]}`);
		const end = lines.indexOf(m[2], i + 1);
		assert.ok(end > i, `matching delimiter not found '${m[2]}'`);
		env[m[1]] = lines.slice(i + 1, end).join('\n');
		i = end;
	}
	return env;
}

test('exports each named secret and decodes each named file', () => {
	const json = '{"project_info":{}}';
	const r = exportSecrets({
		secrets: { URL_DEV: 'https://bff.example/', NOTE_DEV: 'two\nlines', GS_B64: Buffer.from(json).toString('base64') },
		envSecrets: 'URL_DEV NOTE_DEV',
		decodeFiles: 'GS_B64=app/src/dev/google-services.json',
	});
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.deepEqual(parseGithubEnv(r.githubEnv), { URL_DEV: 'https://bff.example/', NOTE_DEV: 'two\nlines' });
	assert.equal(fs.readFileSync(path.join(r.dir, 'app/src/dev/google-services.json'), 'utf8'), json);
});

// The caller didn't pass secrets: inherit, so the environment's secrets are missing.
test('names an env secret that is missing, and leaves GITHUB_ENV readable', () => {
	const r = exportSecrets({ secrets: { A: 'a' }, envSecrets: 'A B' });
	assert.equal(r.status, 1);
	assert.match(r.stdout, /::error::Secret 'B' is empty\..*secrets: inherit/);
	assert.deepEqual(parseGithubEnv(r.githubEnv), { A: 'a' });
});

test('names a file secret that is missing', () => {
	const r = exportSecrets({ secrets: { github_token: 't' }, decodeFiles: 'GS_B64=google-services.json' });
	assert.equal(r.status, 1);
	assert.match(r.stdout, /::error::Secret 'GS_B64' is empty\./);
	assert.ok(!fs.existsSync(path.join(r.dir, 'google-services.json')));
});
