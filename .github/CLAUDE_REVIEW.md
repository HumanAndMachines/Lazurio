# Claude review

This repository uses the official Claude Code Action with an existing personal
Claude subscription. It does not use an Anthropic API key or the separately
billed managed Code Review service.

## Request a review

After `.github/workflows/claude-review.yml` is merged into the default branch:

- GitHub user `immakermatty` (immutable user ID `16311043`) can add a PR comment
  containing exactly `@claude review`.
- The same user can run **Actions → Claude review → Run workflow**, supplying the
  number of an open PR. Use the default branch when dispatching.

The official action also checks the triggering user's repository access.
Other users and bots do not consume this personal subscription through the workflow.
To review again, add a new comment. Editing an old comment does not trigger it.

The result is a GitHub review from `github-actions[bot]`, headed **Claude review**
and tied to the reviewed commit. It is advisory; it never approves or merges a PR.

## Credentials and limits

A repository Actions secret named `CLAUDE_CODE_OAUTH_TOKEN` is required.
The subscription owner generates it with `claude setup-token` and saves it through
GitHub Secrets. Never put the value in source, PR descriptions, logs or chat.
The token can be revoked or replaced without changing the workflow.

Reviews consume the owner's Claude subscription allowance and GitHub Actions
minutes. Runs stop after 15 minutes or 20 model turns. Diffs over 500,000 bytes
or PRs over 300 changed files fail explicitly and should be split.

The workflow checks out the PR base, captures the diff, and verifies that both
base and head still match. Claude has only Read, Grep and Glob tools, with hooks
and project MCP configuration disabled. It does not install or execute PR code.
Only the final publishing step writes a review, and it rejects empty reports,
credential-like text, closed PRs and revisions that changed during review.
This reduces exposure to untrusted PR text; model findings still require human
judgment and do not replace tests or security review.

## Rollback and troubleshooting

Disable **Claude review** in GitHub Actions to stop new runs. Remove the workflow
through a PR and remove the repository secret if retiring the integration;
deleting a GitHub secret does not revoke the underlying Claude token.

If a request does not start, check the comment text, user ID and default-branch
workflow. If authentication fails, renew the subscription token. If the PR
changed while being reviewed, request a fresh review. Full model output is
disabled to keep credentials and raw tool output out of Actions logs.

Setup references: [official action documentation](https://code.claude.com/docs/en/github-actions)
and [action security model](https://github.com/anthropics/claude-code-action/blob/ef8bb1e43bf303cff727a1dd0b8837029fe982a2/docs/security.md).
