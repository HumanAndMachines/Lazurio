const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const workflow = readFileSync(join(__dirname, 'workflows/claude-review.yml'), 'utf8');
const scripts = [...workflow.matchAll(/          node <<'NODE'\n([\s\S]*?)          NODE/g)]
  .map(match => match[1].replace(/^          /gm, ''));
assert.equal(scripts.length, 2);
const publisher = scripts[1];
const gate = workflow.match(/    if: >-\n([\s\S]*?)    environment:/)[1].trim();
const context = () => ({
  actor_id: '16311043', run_attempt: 1, ref: 'refs/heads/main',
  event_name: 'issue_comment', event: { issue: { number: 2, pull_request: {} }, comment: { body: '@claude review' } },
});
test('only owner first-attempt main requests pass the exact workflow gate', () => {
  const accepts = github => !!runInNewContext(gate, { github });
  assert.ok(accepts(context()));
  assert.ok(accepts({ ...context(), event_name: 'workflow_dispatch', event: {} }));
  for (const change of [
    { actor_id: 'other' }, { run_attempt: 2 }, { ref: 'refs/heads/feature' }, { ref: 'refs/tags/main' },
    { event: { issue: {}, comment: { body: '@claude review' } } },
    { event: { issue: { pull_request: {} }, comment: { body: 'Thanks!' } } },
  ]) assert.equal(accepts({ ...context(), ...change }), false);
});
test('concurrency belongs to the authorized job; environment and zero tools are fixed', () => {
  assert.ok(!/^concurrency:/m.test(workflow));
  assert.match(workflow, /^    concurrency:\n      group: claude-review-/m);
  assert.match(workflow, /^    environment: claude-review$/m);
  assert.match(workflow, /^            --tools=$/m);
  assert.doesNotMatch(workflow, /--allowedTools|use_commit_signing/);
  assert.match(workflow, /--disable-slash-commands/);
  assert.match(workflow, /--strict-mcp-config/);
  assert.match(workflow, /--mcp-config '\{"mcpServers":\{\}\}'/);
  assert.match(workflow, /disableAllHooks/);
  assert.doesNotMatch(workflow, /uses: actions\/checkout/);
  assert.match(workflow, /200000/);
  assert.match(workflow, /steps\.diff\.outputs\.patch/);
});
test('diff output uses a fresh delimiter and rejects empty input', () => {
  let result;
  const run = patch => runInNewContext(scripts[0], {
    require: name => name === 'node:crypto' ? { randomUUID: () => 'unique-marker' } : {
      readFileSync: () => patch,
      appendFileSync: (path, value) => { assert.equal(path, 'output'); result = value; },
    }, process: { env: { GITHUB_OUTPUT: 'output' } },
  });
  run('diff\nEOF\nmalicious=value');
  assert.equal(result, 'patch<<unique-marker\ndiff\nEOF\nmalicious=value\nunique-marker\n');
  assert.throws(() => run(' '), /Empty/);
});
function simulate(options = {}) {
  const state = { state: 'open', head: { sha: 'head' }, base: { sha: 'base' } };
  const calls = [];
  let reads = 0;
  const env = {
    GH_REPO: 'owner/repo', PR_NUMBER: '2', BASE_SHA: 'base', HEAD_SHA: 'head',
    REVIEW_JSON: JSON.stringify({ review: 'No actionable findings.' }), ...options.env,
  };
  const execFileSync = (bin, args, request = {}) => {
    assert.equal(bin, 'gh');
    calls.push({ args, input: request.input && JSON.parse(request.input) });
    if (!args.includes('--method')) {
      reads++;
      if (options.readFailure === reads) throw new Error('API read failed');
      return JSON.stringify(reads === 1 ? (options.before || state) : (options.after || state));
    }
    if (args.includes('POST')) {
      if (options.postFailure) throw new Error('API POST failed');
      return JSON.stringify({ id: 42 });
    }
    if (options.putFailure) throw new Error('API PUT failed');
    return '';
  };
  let error;
  try {
    runInNewContext(publisher, {
      require: () => ({ execFileSync }), process: { env }, console: { log() {} },
    });
  } catch (e) { error = e; }
  return { calls, error };
}
test('valid output posts exactly one COMMENT bound to the reviewed commit', () => {
  const result = simulate();
  assert.equal(result.error, undefined);
  const post = result.calls.find(call => call.args.includes('POST'));
  assert.equal(post.input.event, 'COMMENT');
  assert.equal(post.input.commit_id, 'head');
  assert.match(post.input.body, /Commit snapshot/);
  assert.equal(result.calls.length, 3);
});
for (const [name, raw] of [
  ['malformed', '{'], ['null', 'null'], ['missing', '{}'], ['empty', '{"review":" "}'],
  ['wrong type', '{"review":7}'], ['oversized', JSON.stringify({ review: 'x'.repeat(40001) })],
  ['credential', '{"review":"sk-ant-example"}'], ['github credential', '{"review":"github_pat_example"}'],
]) test('rejects ' + name + ' before publication', () => {
  const result = simulate({ env: { REVIEW_JSON: raw } });
  assert.ok(result.error);
  assert.equal(result.calls.length, 0);
});
for (const [name, state] of [
  ['closed', { state: 'closed', head: { sha: 'head' }, base: { sha: 'base' } }],
  ['head', { state: 'open', head: { sha: 'new' }, base: { sha: 'base' } }],
  ['base', { state: 'open', head: { sha: 'head' }, base: { sha: 'new' } }],
]) {
  test('rejects stale ' + name + ' before POST', () => {
    const result = simulate({ before: state });
    assert.ok(result.error);
    assert.equal(result.calls.length, 1);
  });
  test('invalidates a concurrent ' + name + ' change after POST', () => {
    const result = simulate({ after: state });
    assert.ok(result.error);
    assert.match(result.calls.at(-1).input.body, /INVALIDATED/);
    assert.ok(result.calls.at(-1).args.includes('PUT'));
  });
}
test('API failures never report success', () => {
  for (const options of [{ readFailure: 1 }, { postFailure: true }, { readFailure: 2 }, { readFailure: 2, putFailure: true }]) {
    assert.ok(simulate(options).error);
  }
  assert.match(simulate({ readFailure: 2 }).calls.at(-1).input.body, /INVALIDATED/);
});
