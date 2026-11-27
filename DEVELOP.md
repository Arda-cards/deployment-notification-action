# Developing Deploy Slack Notify

## Entry points

- [post/action.yaml](post/action.yaml), [update/action.yaml](update/action.yaml), and [announce/action.yaml](announce/action.yaml)
  define the three JavaScript actions.
  Each handler lives in its own `index.js` and reads the inputs it uses. Shared input names and context validation,
  reading, and writing live in [context.js](context.js). Message preparation lives in [notify.js](notify.js).
  The actions use CommonJS and run on the runner's built-in Node.js 24 runtime without a build step. The runner's
  `INPUT_*` variables preserve hyphens in input names. For local verification, run `node post/index.js`,
  `node update/index.js`, or `node announce/index.js` with mocked APIs and the inputs for that action.
- [undeployed-digest.js](undeployed-digest.js) is a separate entry point for a scheduled workflow. It posts one message
  about commits on `main` that have yet to reach the final purpose.
- [slack.js](slack.js) handles posting and updating Slack messages for the three actions and the digest. [io.js](io.js)
  handles GitHub, filesystem, and workflow-command I/O. [lib.js](lib.js) holds the pure helpers exercised by Jest.

## Actions Toolkit

The actions use GitHub's `@actions/core` package to read inputs, write the `context` output, and register the Slack and
GitHub tokens for masking in runner logs. It also issues warning and notice annotations. The actions use
`@actions/github` for release lookups. The shared Toolkit bundle is
included in the repository so workflows can run
the actions directly. When updating the dependency, run `npm ci` followed by `npm run build` and include the regenerated
bundle and license notices under `vendor/actions-toolkit/`.

## Error handling

Each entry point catches runtime errors, emits a warning that names the failed operation, and exits successfully. `githubApi`
returns `null` after warning about an HTTP or network failure. The Slack helpers throw when Slack reports an error so the
entry point can report it consistently. A missing or invalid user map behaves as an empty map.

## Deployment notification

The frontend deployment workflow posts after `dev` finishes. The `/post` action writes a single `context` output to
`GITHUB_OUTPUT` with the actual Slack `channel_id`, the `message_ts`, the ordered `tracked_purposes` array, `version`,
`jobNamePattern`, `user-map-path`, and the configured `slack-channel`.
`/update` uses the resolved `channel_id` to edit the existing message and keeps its purpose order. `/announce` posts
to its `slack-channel` input. An omitted or blank channel emits a workflow notice and skips the announcement before
loading the context. Missing or malformed context produces a warning when an action needs it to send a notification.
Both consumers use the context version for Slack titles and release lookups and read the stored user map path.
`/update` uses the stored job name pattern for live status lookup. A context missing these fields uses an empty version,
the `deploy ($purpose)` job pattern, and `.github/deploy-notify/user-map.json`.
The notifier reads the event and SHA from `@actions/github` context. For `workflow_run` events, it uses the triggering
run's `workflow_run.head_sha` when available. Otherwise it uses the current run's `GITHUB_SHA`.

### Status resolution

On `/post`, `tracked-purpose` controls the ordered list of deployment purposes and defaults to `dev, stage, demo, prod`. The parser
trims names, lowercases them, ignores blanks, and keeps the first occurrence of each name. The optional `purpose` and
`status` inputs supply one status hint for a tracked purpose. The action trims and lowercases the purpose name.
`normalizePurposeStatus` maps a skipped deploy job to `blocked` because its
upstream dependency prevented it from running. Empty and unrecognized values map to `pending`.
`resolvePurposeStatuses` applies these sources in order:

1. A terminal workflow hint from `needs.<job>.result`. Terminal statuses are `success`, `failure`, `blocked`, and `cancelled`.
2. The conclusion of a completed job in the live run.
3. The run's pending deployment approvals, which set `awaiting`.
4. A live job in progress, which sets `in_progress`.
5. The normalized workflow hint if the live run has no matching result.

`runJobs` and `awaitingApprovalPurposes` require `actions: read`. They return empty lists on failure. `indexPurposeJobs`
substitutes each tracked purpose for `$purpose` in `jobNamePattern`. It matches job names case-insensitively,
including reusable workflow names such as `deploy (stage) / Apply`. A pattern without `$purpose` matches
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

When a workflow supplies `version` to `/post`, `fetchRelease` uses `@actions/github` to look up a published release
with that exact tag. A match supplies the release body and a release link. A release with an empty body still supplies its link.
When the version is blank, the release is missing, or the lookup fails, the action uses the commit comparison.

`lastSuccessfulDeploySha` first checks the 20 most recent deployment records for the last tracked purpose. GitHub calls
this an environment in its API. A record can exist as soon as the job is released. Its latest status must be `success`
to qualify. The fallback checks up to 20
successful runs of `DEPLOY_WORKFLOW` (`deploy.yaml` by default) and matches the branch locally because applying both
the branch and success filters in the GitHub API has returned stale results. The fallback assumes the workflow succeeds only
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
Release notes use a Slack Markdown block and are shortened to fit its 12,000-character limit. The footer links to the
full release. [Slack Markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/)

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
unparsable schedule allows the digest to run.

## Verification

Use the Node.js version in `.nvmrc` and run the tests from the repository root:

```sh
npm ci
npm test
```

- [lib.status.test.js](lib.status.test.js) covers status normalization, job indexing, approvals, and headline priority.
- [lib.message.test.js](lib.message.test.js) covers escaping, mentions, timing, field pairs, links, and Block Kit
  layouts for single changes and ranges.
- [lib.digest.test.js](lib.digest.test.js) covers summer and winter schedules, delayed runs, commit selection, and
  author-grouped digest text.
- [action-runtime.test.js](action-runtime.test.js) checks that the Node.js major in `.nvmrc` matches every action manifest.

Use mocked GitHub and Slack responses to smoke-test the entry points and pass `/post`'s `context` output to `/update`
and `/announce`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for linting.
