# Deploy Slack Notify

Track a commit through dev, stage, demo, and production in a single Slack message. Use `/post` to create the message,
`/update` to edit it, and `/announce` to post a standalone announcement. Notification errors are reported as warnings
so the deploy can continue.

See the [post action inputs and outputs](post/action.yaml), [update action inputs](update/action.yaml),
[announce action inputs](announce/action.yaml),
[release history](CHANGELOG.md), and [developer guide](DEVELOP.md).

## Usage

All three actions use the GitHub Actions runner's built-in Node.js 24 runtime. Provide a Slack bot token with `chat:write`
and a channel the bot can post to.
Pass the `message-ts` and `channel-id` outputs from `/post` to later `/update` steps, along with the Slack bot token and
channel. Call `/announce` after the final deployment succeeds and set `slack-channel` to the announcement destination.

Set `tracked-purpose` to a comma-separated list in deployment order, such as `preview, stage, prod`.
Use the same list for `post`, `update`, and `announce`. An omitted or blank list defaults to `dev, stage, demo, prod`.
The last purpose sets the baseline for comparing changes and is named when the deployment completes.
Slack headlines include the calling repository's name, for example `arda-frontend-app live in release`.
Set the optional `version` input to display it after the repository name, as in `arda-frontend-app v1.2.3 live in release`.
The default is an empty string. Pass the same version to `post`, `update`, and `announce` to show it throughout a deployment.
The optional `jobNamePattern` input controls which GitHub Actions job names the action uses for live status.
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

Use the output expressions below in a later step of the same job. For a separate job, expose the post step's outputs
as job outputs and read them through `needs`.

```yaml
- name: Update deployment status
  uses: Arda-cards/deployment-notification-action/update@main
  with:
    purpose: stage
    status: success
    message-ts: ${{ steps.notify.outputs.message-ts }}
    channel-id: ${{ steps.notify.outputs.channel-id }}
    github-token: ${{ github.token }}
    slack-bot-token: ${{ secrets.SLACK_DEPLOY_BOT_TOKEN }}
    slack-channel: ${{ vars.SLACK_DEPLOY_CHANNEL }}
```

```yaml
- name: Announce deployment
  uses: Arda-cards/deployment-notification-action/announce@main
  with:
    github-token: ${{ github.token }}
    slack-bot-token: ${{ secrets.SLACK_DEPLOY_BOT_TOKEN }}
    slack-channel: ${{ vars.SLACK_PRODUCT_CHANNEL }}
```

To mention authors in Slack, check out the calling repository before invoking the action and provide
`.github/deploy-notify/user-map.json`, or set `user-map-path` to a different path relative to the workspace. The file
maps GitHub logins to Slack user IDs under a `users` key.

## GitHub token permissions

```yaml
permissions:
  actions: read
  deployments: read
  pull-requests: read
```
