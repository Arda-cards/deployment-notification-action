# Developing Deploy Slack Notify

## Entry points

- [action.yaml](action.yaml) defines the workflow inputs and outputs and runs [notify.js](notify.js) on GitHub Actions'
  built-in Node.js 24 runtime. The JavaScript uses CommonJS and runs without a build step. The notifier reads the
  runner's `INPUT_*` variables, which preserve hyphens in input names. Direct invocations can use the original
  environment variables such as `MODE`, `COMMIT_SHA`, `PURPOSE`, and `STATUS`.
- [undeployed-digest.js](undeployed-digest.js) is a separate entry point for a scheduled workflow. It posts one message
  about commits on `main` that have yet to reach the final purpose.
- [io.js](io.js) shares GitHub, Slack, filesystem, and workflow-command I/O between the entry points. [lib.js](lib.js)
  holds the pure status, filtering, and rendering helpers exercised by Jest.

Both entry points catch runtime errors, emit a warning with the script's title, and exit successfully. `githubApi`
returns `null` after warning about an HTTP or network failure. `slackCall` throws when Slack reports an error so the
entry point can report it consistently. A missing or invalid user map behaves as an empty map.

## Deployment notification

In the frontend deployment workflow, `post` runs after `dev` finishes and returns the Slack message timestamp and
channel ID through `GITHUB_OUTPUT`. Calls to `update` use those outputs to edit the same message as the commit moves through
the configured purposes. The `announce` call sends a separate announcement for the final purpose.
When `commit-sha` is empty, the notifier uses `GITHUB_SHA`, which also covers manual deployment runs.

### Status resolution

`tracked-purpose` controls the ordered list of deployment purposes and defaults to `dev, stage, demo, prod`. The parser
trims names, lowercases them, ignores blanks, and keeps the first occurrence of each name. The optional `purpose` and
`status` inputs supply one status hint for a tracked purpose. The action trims and lowercases the purpose name.
`normalizePurposeStatus` maps a skipped deploy job to `blocked` because its
upstream dependency prevented it from running. Empty and unrecognized values map to `pending`.
`resolvePurposeStatuses` applies these sources in order:

1. A terminal workflow hint from `needs.<job>.result`. Terminal statuses are `success`, `failure`, `blocked`, and
   `cancelled`.
2. The conclusion of a completed job in the live run.
3. The run's pending deployment approvals, which set `awaiting`.
4. A live job in progress, which sets `in_progress`.
5. The normalized workflow hint if the live run has no matching result.

`runJobs` and `awaitingApprovalPurposes` require `actions: read`. They return empty lists on failure. `indexPurposeJobs`
substitutes each tracked purpose for `$purpose` in `jobNamePattern`. It matches job names case-insensitively,
including names followed by a reusable workflow suffix such as ` / Apply`. A pattern without `$purpose` matches
no jobs. The index keeps the first match because a rerun can include the original job in the list.
Each resolved purpose carries its name, status, nullable `createdAt`, `startedAt`, and `completedAt` timestamps, and
a `source` of `hint`, `job`, or `approval`. The notifier checks the live run up to five times, three seconds apart, while
an `in_progress` hint remains unconfirmed. This gives the job or its approval time to appear in the API.

`currentStatusHeadline` prioritizes failures, blocked or cancelled stages, active deployments, and pending approvals,
in that order. When every tracked purpose succeeds, the headline names the last one, as in “Live in prod.”
The default is “Queued.” Finished jobs with valid start and completion
times show a compact duration. Active deployments show their start time, with creation time as a fallback. Approval
waits show when the job was created, which is when approval was requested, with start time as a fallback. Slack's
`!date` token displays the time in the reader's timezone and includes a UTC fallback. A timestamp stays accurate
between message edits.

### Final deployment baseline and changes

`lastSuccessfulDeploySha` first checks the 20 most recent deployment records for the last tracked purpose. GitHub calls
this an environment in its API. A record can exist as soon as the job is released. Its latest status must be `success`
to qualify. The fallback checks up to 20
successful runs of `DEPLOY_WORKFLOW` (`deploy.yaml` by default) and matches the branch locally because combining the
API's branch and success filters has returned stale results. This fallback assumes the workflow reaches success only
after the final purpose has deployed. Both lookups return `null` when they find no qualifying SHA.

The notifier excludes both the commit being built and the run's `GITHUB_SHA` from the baseline lookup. In a
`workflow_run` deployment these can differ, and the final job may already have recorded a successful
deployment when the notifier runs. `compareCommits` returns GitHub's oldest-first order and defaults its head to
`main`. The notifier reverses the range for display. It drops `[changelog-assembly]` commits and commits authored by a
login ending in `[bot]`. Keep the changelog marker in sync with the calling repository's release workflow. If the
baseline cannot be found, the message identifies the head commit on its own.

The normalized comparison records contain `sha`, `shortSha`, `login`, `authorName`, `subject`, `committedAt`, `htmlUrl`,
and `prNumber`. The committer's date takes precedence over the author's date. `parsePrNumber` prefers a trailing
squash-merge `(#123)` suffix, with a bare `#123` as a fallback.

### Slack rendering

`buildDeployMessage` returns `{ text, blocks }`. `text` is the plain-text notification and accessibility fallback.
The headline and fallback text use the repository name from the calling workflow's `owner/repo` value.
The blocks place the status headline first, then the PR or commit title and author on their own lines for a single
change. For multiple changes, the message shows the purpose rows before the grouped change list. Each row uses two
Block Kit fields so Slack aligns the purpose name and status. Each section holds up to five rows.
Status rows use colored dots, with a stop icon for
`blocked`. The row can use a shorter label than the prose, such as “awaiting” for “awaiting approval.” Workflow run and
comparison or commit links appear in a context footer. `buildProdAnnouncement` names the final purpose and uses the
same single-change or grouped-range treatment and footer. The default destination is displayed as “production.”

Slack headers are capped at 150 characters. [Slack header block](https://docs.slack.dev/reference/block-kit/blocks/header-block/)
See the [Slack section block field limits](https://docs.slack.dev/reference/block-kit/blocks/section-block/).

`escapeSlackText` escapes `&`, `<`, and `>` so Slack reads them as text. Link labels use plain text because Slack renders
inline markup such as backticks literally inside link labels. Commit links prefer a PR when one is known and trim the
redundant squash-merge suffix when the PR number already prefixes the label. Subjects use one line capped at 100
characters by default.

`groupCommitsByAuthor` groups by GitHub login, falling back to the Git author name, and sorts by commit count.
`renderAuthorGroups` is shared by the notifier and the digest. Each author appears once with one commit per line below their heading. The
default cap is five commits per author, with a `+N more` line for the remainder. `resolveMention` uses `<@SLACKID>` to
notify a mapped user, `@login` as plain text for an unmapped login, and a neutral fallback for an unknown author. A
group with only a Git author name uses that name in bold.

## Undeployed digest

The digest reads the comma-separated `TRACKED_PURPOSES` environment variable, using the same default as the action.
It compares the final purpose's baseline with `main` and removes automated commits and commits within the grace
window (`GRACE_MINUTES`, 90 by default) to allow in-flight deployments to finish. An empty result produces no Slack
message. The message puts its purpose, commit and author totals, and comparison baseline on separate lines, followed
by the author groups and a footer explaining why changes may still be waiting to deploy.

The calling workflow can schedule two candidate UTC crons for the same local delivery hour across daylight saving
changes. Pass the triggering expression from `github.event.schedule` as `SCHEDULE`. `shouldRunForSchedule` reads its
numeric minute and hour and converts that UTC time on the current UTC date into `TARGET_TZ`. This uses the intended
cron time even if the runner starts late. The defaults are `TARGET_HOUR=9` and `TARGET_TZ=America/Los_Angeles`. For
example, `16:30 UTC` falls in the target hour during daylight saving time and `17:30 UTC` does so during standard time.
The time conversion normalizes ICU's `24` representation of midnight to `0`. A manual `workflow_dispatch` or an
unparseable schedule allows the digest to run.

## Verification

With Node.js 24 and Jest available, run the three suites from the repository root:

```sh
jest --config '{}' --runInBand
```

- [lib.status.test.js](lib.status.test.js) covers status normalization, job indexing, approvals, and headline priority.
- [lib.message.test.js](lib.message.test.js) covers escaping, mentions, timing, field pairs, links, and Block Kit
  layouts for single changes and ranges.
- [lib.digest.test.js](lib.digest.test.js) covers summer and winter schedules, delayed runs, commit selection, and
  author-grouped digest text.

Use mocked GitHub and Slack responses to smoke-test the entry points and the `GITHUB_OUTPUT` file contract.
See [CONTRIBUTING.md](CONTRIBUTING.md) for linting.
