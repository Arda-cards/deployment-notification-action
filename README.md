# Deploy Slack Notify

Track a commit through dev, stage, demo, and production in a single Slack message. Use `/post` to create the message,
`/update` to edit it, and `/announce` to post a standalone announcement. Notification errors are reported as warnings
so the deploy can continue.

See the [post action inputs and outputs](post/action.yaml), [update action inputs](update/action.yaml),
[announce action inputs](announce/action.yaml),
[release history](CHANGELOG.md), and [developer guide](DEVELOP.md).

## Usage

All three actions use the GitHub Actions runner's built-in Node.js 24 runtime and a Slack bot token with `chat:write`.
Set `slack-channel` on `/post`. Both `/update` and `/announce` use the channel from the resulting context.

Pass the `context` output from `/post` directly to `/update` and `/announce`. It is a JSON string containing
`channel_id`, `message_ts`, the ordered `tracked_purposes` array, `version`, `jobNamePattern`, `user-map-path`, and
`slack-channel`.
`/update` uses the stored message IDs, and `/announce` uses the last purpose in the array. Call `/announce` after the
final deployment succeeds.

The actions use the triggering workflow run's `head_sha` for `workflow_run` events when available and `github.sha`
otherwise.

Set `tracked-purpose` on `/post` to a comma-separated list in deployment order, such as `preview, stage, prod`.
An omitted or blank list defaults to `dev, stage, demo, prod`. The last purpose sets the baseline for comparing changes
and is named when the deployment completes.
Slack headlines include the calling repository's name, for example `arda-frontend-app live in release`.
Set the optional `version` input on `/post` to display it after the repository name, as in
`arda-frontend-app v1.2.3 live in release`. It defaults to an empty string. `/update` and `/announce` read it from `context`.
When `version` matches a published GitHub release tag, Slack displays its release notes in place of the commit list.
The commit list is used when the version is blank or a matching release is unavailable.
Set the optional `jobNamePattern` input on `/post` to control live job matching. `/update` reads it from `context`.
It defaults to `deploy ($purpose)`, which matches a job named `deploy (stage)` for `stage`.
Set `jobNamePattern: 'deploy-$purpose'` for workflows with names such as `deploy-stage`.
For `post` and `update`, pass `purpose` and `status` together to give one tracked purpose a status hint.
`purpose` defaults to an empty string and `status` defaults to `pending`. The action also checks live jobs and approvals
for the tracked purposes.

The examples use `main` as the action ref. Replace it with your chosen tag or commit SHA to pin the actions.

```yaml
steps:
  - name: Post deployment status
    id: notify
    uses: Arda-cards/deployment-notification-action/post@main
    with:
      purpose: stage
      status: in_progress
      github-token: ${{ github.token }}
      slack-bot-token: ${{ secrets.SLACK_DEPLOY_BOT_TOKEN }}
      slack-channel: ${{ vars.SLACK_DEPLOY_CHANNEL }}
```

Use the `context` expression below in later steps of the same job. For a separate job, expose the post step's `context`
as a job output and read it through `needs`.

```yaml
- name: Update deployment status
  uses: Arda-cards/deployment-notification-action/update@main
  with:
    context: ${{ steps.notify.outputs.context }}
    purpose: stage
    status: success
    github-token: ${{ github.token }}
    slack-bot-token: ${{ secrets.SLACK_DEPLOY_BOT_TOKEN }}
```

```yaml
- name: Announce deployment
  uses: Arda-cards/deployment-notification-action/announce@main
  with:
    context: ${{ steps.notify.outputs.context }}
    github-token: ${{ github.token }}
    slack-bot-token: ${{ secrets.SLACK_DEPLOY_BOT_TOKEN }}
```

To mention authors in Slack, check out the calling repository before invoking the action and provide
`.github/deploy-notify/user-map.json`, or set `user-map-path` on `/post` to a different path relative to the workspace.
`/update` and `/announce` read the path from `context`. Make the file available in their jobs as well. The file maps
GitHub logins to Slack user IDs under a `users` key.

## GitHub token permissions

```yaml
permissions:
  actions: read
  contents: read
  deployments: read
  pull-requests: read
```
