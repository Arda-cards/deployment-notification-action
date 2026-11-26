const { getInput, setOutput, setSecret } = require('./vendor/actions-toolkit/core.cjs');

function readInput(name, fallback) {
  const value = getInput(name, { trimWhitespace: false });
  if (value || fallback === undefined) return value;
  const key = `INPUT_${name.replaceAll(' ', '_').toUpperCase()}`;
  return Object.hasOwn(process.env, key) ? value : fallback;
}

function readSecretInput(name, fallback) {
  const value = readInput(name, fallback);
  if (process.env.GITHUB_ACTIONS === 'true' && value.trim()) setSecret(value);
  return value;
}

function validateNotificationContext(context) {
  const { channel_id, message_ts, tracked_purposes } = context ?? {};
  if (typeof channel_id !== 'string' || !channel_id.trim() ||
      typeof message_ts !== 'string' || !message_ts.trim() ||
      !Array.isArray(tracked_purposes) || !tracked_purposes.length ||
      !tracked_purposes.every((purpose) => typeof purpose === 'string' && purpose.trim())) {
    throw new Error('context must include a channel_id, message_ts, and a non-empty tracked_purposes array.');
  }
  return { channel_id, message_ts, tracked_purposes };
}

function readNotificationContext() {
  const input = readInput('context', process.env.CONTEXT);
  if (!input.trim()) throw new Error('No context was provided from the post action.');
  let context;
  try {
    context = JSON.parse(input);
  } catch {
    throw new Error('context must be valid JSON from the post action.');
  }
  return validateNotificationContext(context);
}

function writeNotificationContext(context) {
  const validated = validateNotificationContext(context);
  if (process.env.GITHUB_OUTPUT) setOutput('context', validated);
}

function readSharedInputs() {
  const env = process.env;
  const {
    DEPLOY_WORKFLOW: workflowFile = 'deploy.yaml',
    GITHUB_REPOSITORY: repository = env.REPOSITORY,
    GITHUB_SERVER_URL: serverUrl = env.SERVER_URL ?? 'https://github.com',
    GITHUB_RUN_ID: runId = env.RUN_ID ?? '',
    GITHUB_WORKSPACE: workspace = process.cwd(),
    GITHUB_SHA: runSha,
  } = env;

  const slackToken = readSecretInput('slack-bot-token', env.SLACK_BOT_TOKEN);
  if (!slackToken) {
    throw new Error('slack-bot-token is required — skipping deploy notification.');
  }

  return {
    version: readInput('version'),
    slackToken,
    githubToken: readSecretInput('github-token', env.GITHUB_TOKEN),
    userMapPath: readInput('user-map-path', env.USER_MAP_PATH ?? '.github/deploy-notify/user-map.json'),
    workflowFile, repository, serverUrl, runId, workspace, runSha,
    commitSha: readInput('commit-sha', env.COMMIT_SHA) || runSha || '',
  };
}

function readStatusInputs() {
  return {
    jobNamePattern: readInput('jobNamePattern'),
    inputPurpose: readInput('purpose', process.env.PURPOSE),
    status: readInput('status', process.env.STATUS ?? 'pending'),
  };
}

function readSlackChannel() {
  const channel = readInput('slack-channel', process.env.SLACK_CHANNEL);
  if (!channel) {
    throw new Error('slack-channel is required — skipping deploy notification.');
  }
  return channel;
}

module.exports = {
  readInput,
  readNotificationContext,
  writeNotificationContext,
  readSharedInputs,
  readStatusInputs,
  readSlackChannel,
};
