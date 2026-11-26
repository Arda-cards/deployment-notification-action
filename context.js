const { appendFileSync } = require('node:fs');

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

function readNotificationContext(env) {
  const input = env.INPUT_CONTEXT ?? env.CONTEXT ?? '';
  if (!input.trim()) throw new Error('No context was provided from the post action.');
  let context;
  try {
    context = JSON.parse(input);
  } catch {
    throw new Error('context must be valid JSON from the post action.');
  }
  return validateNotificationContext(context);
}

function writeNotificationContext(context, env) {
  const validated = validateNotificationContext(context);
  const output = env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `context=${JSON.stringify(validated)}\n`);
}

function readSharedInputs(env) {
  const {
    INPUT_VERSION: version,
    'INPUT_COMMIT-SHA': inputSha = env.COMMIT_SHA ?? '',
    'INPUT_SLACK-BOT-TOKEN': slackToken = env.SLACK_BOT_TOKEN,
    'INPUT_GITHUB-TOKEN': githubToken = env.GITHUB_TOKEN,
    'INPUT_USER-MAP-PATH': userMapPath = env.USER_MAP_PATH ?? '.github/deploy-notify/user-map.json',
    DEPLOY_WORKFLOW: workflowFile = 'deploy.yaml',
    GITHUB_REPOSITORY: repository = env.REPOSITORY,
    GITHUB_SERVER_URL: serverUrl = env.SERVER_URL ?? 'https://github.com',
    GITHUB_RUN_ID: runId = env.RUN_ID ?? '',
    GITHUB_WORKSPACE: workspace = process.cwd(),
    GITHUB_SHA: runSha,
  } = env;

  if (!slackToken) {
    throw new Error('slack-bot-token is required — skipping deploy notification.');
  }

  return {
    version, slackToken, githubToken, userMapPath, workflowFile, repository, serverUrl, runId, workspace, runSha,
    commitSha: inputSha || runSha || '',
  };
}

function readStatusInputs(env) {
  const {
    INPUT_JOBNAMEPATTERN: jobNamePattern,
    INPUT_PURPOSE: inputPurpose = env.PURPOSE ?? '',
    INPUT_STATUS: status = env.STATUS ?? 'pending',
  } = env;
  return { jobNamePattern, inputPurpose, status };
}

function readSlackChannel(env) {
  const channel = env['INPUT_SLACK-CHANNEL'] ?? env.SLACK_CHANNEL;
  if (!channel) {
    throw new Error('slack-channel is required — skipping deploy notification.');
  }
  return channel;
}

module.exports = {
  readNotificationContext,
  writeNotificationContext,
  readSharedInputs,
  readStatusInputs,
  readSlackChannel,
};
