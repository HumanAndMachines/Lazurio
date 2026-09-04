# Claude review

This repository uses the official pinned Claude Code Action and the owner's
existing Claude subscription, not an Anthropic API key or managed Code Review.

## Request a review

After merge into `main`, GitHub user `immakermatty` (immutable ID `16311043`)
can add exactly `@claude review` to an open PR or dispatch **Claude review**
from **main** with its PR number. Only first attempts run: to retry, create a
new request, not **Re-run jobs**. Unrelated comments cannot cancel review jobs.

The result is an advisory COMMENT review by `github-actions[bot]`, explicitly
bound to a commit snapshot. It never approves, edits, merges or deploys code.

## Trust boundary and subscription custody

The `CLAUDE_CODE_OAUTH_TOKEN` secret belongs exclusively to the `claude-review`
GitHub environment. That environment must have **Selected branches and tags**,
with exactly one **Branch: main** policy and no tag policies. Do not create a
same-named repository or organization secret: that would bypass this boundary.
The environment policy, not an editable feature-branch workflow condition,
prevents other workflow refs from receiving the token. Repository admins and
people authorized to change trusted main workflows remain trusted custodians.

The job additionally requires the owner's immutable ID, `refs/heads/main`,
and `github.run_attempt == 1`. The official action checks repository access.
The environment's branch policy does not replace these caller checks.

Claude receives a bounded PR diff directly as prompt data. There is no checkout
and **no model filesystem, shell or network tool** (`--tools=`), no skills,
no hooks and no MCP servers. This intentionally sacrifices unchanged-file
context rather than exposing runner files, process environment or credential
stores to model-selected reads. The OAuth-authenticated harness remains trusted;
the model only receives the supplied diff and returns structured text.
The equals form of the empty tools option preserves its empty value through
the pinned action's argument parser; do not replace it with a quoted empty token.
Diffs above 200,000 bytes or 300 changed files are rejected. A review is limited
to 15 minutes and 20 model turns, consuming subscription allowance and Actions
minutes. Missing context and AI mistakes remain explicit review limitations.

A fixed publisher checks structured output, rejects recognizable token prefixes,
and verifies base/head/open state before posting. Prefix filtering is defense in
depth, not the credential isolation boundary. After posting, it rechecks state
and marks the review **INVALIDATED** if state changed or cannot be read back.
GitHub provides no atomic compare-and-post review operation: even a successful
readback is a point-in-time observation. Every report therefore remains labeled
as a commit snapshot, never a promise about the current branch. Failed posting,
readback or invalidation is reported as a failed run; inspect the PR before retrying.

## Verification and rollback

`node --test .github/claude-review.test.cjs` tests the actual inline publisher,
diff-output encoding, caller/ref/attempt gates and fixed tool policy. The
secret-free **Claude review contract** CI runs these tests on workflow changes.
No repository dependencies or lifecycle scripts are installed by either workflow.

Disable **Claude review** to stop requests. Renew the token with
`claude setup-token` and replace it only in the protected environment.
Removing a GitHub secret does not revoke its OAuth token; revoke separately
when retiring it. Never put credential values in Git, logs or chat.
The integration requires the environment secret and reviewed main workflow;
a missing prerequisite fails closed.

References: [official action](https://code.claude.com/docs/en/github-actions),
[CLI tools](https://code.claude.com/docs/en/cli-reference),
[GitHub environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
