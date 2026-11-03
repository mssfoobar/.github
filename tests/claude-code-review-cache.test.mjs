// The reusable review's opt-in cache (ops-hub AOH-10251): with its inputs
// empty, nothing about the review changes; with them set, it can only read.
//
// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yaml = fs.readFileSync(new URL('../.github/workflows/claude-code-review.yml', import.meta.url), 'utf8');
const steps = yaml.split(/\n(?= {6}- name: )/).slice(1);
const step = (name) => {
	const s = steps.find((x) => x.startsWith(`      - name: ${name}\n`));
	assert.ok(s, `no step "${name}"`);
	return s;
};
const ifOf = (s) => /\n {8}if: (.*)\n/.exec(s)?.[1];
const ACTION = /uses: anthropics\/claude-code-action@([0-9a-f]{40}) /;

test('the cache inputs default to empty', () => {
	for (const k of ['cache_role_arn', 'cache_bucket']) assert.match(yaml, new RegExp(`\\n      ${k}:\\n        required: false\\n        type: string\\n        default: ''\\n`));
});

test('with the inputs empty, the cache steps never run, so the review gets the paths\' defaults', () => {
	const creds = step('Cache credentials');
	assert.equal(ifOf(creds), "steps.auth.outputs.method != 'skip' && inputs.cache_role_arn != '' && inputs.cache_bucket != ''");
	// The restore runs only after credentials were obtained, so only when both inputs are set.
	assert.equal(ifOf(step('Restore Claude Code from the cache')), "steps.auth.outputs.method != 'skip' && steps.cache-aws.outcome == 'success'");
	// A skipped step's outputs are empty strings: the action's own defaults.
	const run = step('Run Claude Code Review');
	assert.match(run, /\n {10}path_to_claude_code_executable: \$\{\{ steps\.cc-cache\.outputs\.claude-path \}\}\n/);
	assert.match(run, /\n {10}path_to_bun_executable: \$\{\{ steps\.cc-cache\.outputs\.bun-path \}\}\n/);
});

test('neither cache step can fail the review, or stall it', () => {
	for (const n of ['Cache credentials', 'Restore Claude Code from the cache']) {
		assert.match(step(n), /\n {8}continue-on-error: true\n/);
		assert.match(step(n), /\n {8}timeout-minutes: 5\n/);
	}
});

test('the credentials never reach the job environment', () => {
	const creds = step('Cache credentials');
	assert.match(creds, /\n {10}output-credentials: true\n/);
	assert.match(creds, /\n {10}output-env-credentials: false\n/);
	assert.doesNotMatch(yaml, /AWS_[A-Z_]*:\s*\$\{\{\s*steps\.cache-aws/, 'no step env holds them; they go to the cache action as inputs');
});

test('the cache action is pinned, and describes the action the review runs', () => {
	const restore = step('Restore Claude Code from the cache');
	assert.match(restore, /uses: mssfoobar\/\.github\/\.github\/actions\/claude-code-cache@[0-9a-f]{40} /);
	const ref = /\n {10}action-ref: ([0-9a-f]{40})\n/.exec(restore)?.[1];
	assert.equal(ref, ACTION.exec(step('Run Claude Code Review'))?.[1], 'bump action-ref with the claude-code-action SHA');
});

test('the review saves no cache', () => {
	assert.doesNotMatch(yaml, /uses:\s*runs-on\/cache(?:\/save)?@/);
	assert.doesNotMatch(yaml, /uses:\s*actions\/cache(?:\/save)?@/);
});
