# Deploy Slack Notify

Track a commit through dev, stage, demo, and production in a single Slack message. Use `post` to create the status message,
`update` to edit it, and `announce` to send a standalone announcement for the final deployment. Notification errors are reported as
warnings so the deploy can continue.

See [action.yaml](action.yaml) for inputs and outputs and [CHANGELOG.md](CHANGELOG.md) for release history.
See [DEVELOP.md](DEVELOP.md) for implementation details and local verification.

## Usage

The action uses the GitHub Actions runner's built-in Node.js 24 runtime. Provide a Slack bot token with `chat:write`
and a channel the bot can post to.
Pass the `message-ts` and `channel-id` outputs from `post` to later `update` steps, along with the Slack bot token and
channel. Use `announce` with the channel that should receive the final deployment announcement.

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

The example uses `main` as the action ref. Replace it with your chosen tag or commit SHA to pin the action.

```yaml
steps:
  - name: Post deployment status
    id: notify
    uses: Arda-cards/deployment-notification-action@main
    with:
      mode: post
      purpose: stage
      status: in_progress
      github-token: ${{ github.token }}
      slack-bot-token: ${{ secrets.SLACK_DEPLOY_BOT_TOKEN }}
      slack-channel: ${{ vars.SLACK_DEPLOY_CHANNEL }}
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
