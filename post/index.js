const {
  DEFAULT_USER_MAP_PATH,
  readInput,
  readSharedInputs,
  readStatusInputs,
  writeNotificationContext,
} = require('../context');
const { parseTrackedPurposes } = require('../lib');
const { fetchStatusMessage, notice, warn } = require('../notify');
const { postMessage } = require('../slack');

function readPostInputs() {
  const inputs = readSharedInputs();
  const channel = readInput('slack-channel', process.env.SLACK_CHANNEL);
  if (!channel.trim()) throw new Error('slack-channel is required — skipping deploy notification.');

  return {
    ...inputs,
    ...readStatusInputs(),
    jobNamePattern: readInput('jobNamePattern'),
    userMapPath: readInput('user-map-path', process.env.USER_MAP_PATH ?? DEFAULT_USER_MAP_PATH),
    version: readInput('version'),
    channel,
    names: parseTrackedPurposes(readInput('tracked-purpose', process.env.TRACKED_PURPOSES)),
  };
}

async function post() {
  try {
    const inputs = readPostInputs();
    const { channel, names, slackToken, version, jobNamePattern, userMapPath } = inputs;
    const { message, summary } = await fetchStatusMessage(inputs, names);
    const response = await postMessage(slackToken, { channel, ...message });
    writeNotificationContext({
      channel_id: response.channel,
      message_ts: response.ts,
      tracked_purposes: names,
      version,
      jobNamePattern,
      'user-map-path': userMapPath,
      'slack-channel': channel,
    });
    notice(`Posted deploy status message (ts=${response.ts}): ${summary}`);
  } catch (err) {
    warn(`Could not post deployment status: ${err.message}`);
  }
}

if (require.main === module) post();

module.exports = post;
