const {
  readSharedInputs,
  readSlackChannel,
  readStatusInputs,
  writeNotificationContext,
} = require('../context');
const { parseTrackedPurposes } = require('../lib');
const { fetchStatusMessage, notice, warn } = require('../notify');
const { postMessage } = require('../slack');

function readPostInputs(env) {
  return {
    ...readSharedInputs(env),
    ...readStatusInputs(env),
    channel: readSlackChannel(env),
    names: parseTrackedPurposes(env['INPUT_TRACKED-PURPOSE'] ?? env.TRACKED_PURPOSES),
  };
}

async function post() {
  try {
    const inputs = readPostInputs(process.env);
    const { channel, names, slackToken } = inputs;
    const { message, summary } = await fetchStatusMessage(inputs, names);
    const response = await postMessage(slackToken, { channel, ...message });
    writeNotificationContext({
      channel_id: response.channel,
      message_ts: response.ts,
      tracked_purposes: names,
    }, process.env);
    notice(`Posted deploy status message (ts=${response.ts}): ${summary}`);
  } catch (err) {
    warn(`Could not post deployment status: ${err.message}`);
  }
}

if (require.main === module) post();

module.exports = post;
