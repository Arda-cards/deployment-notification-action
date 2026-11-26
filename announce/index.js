const { readNotificationContext, readSharedInputs, readSlackChannel } = require('../context');
const { buildProdAnnouncement } = require('../lib');
const { fetchMessageArgs, notice, warn } = require('../notify');
const { postMessage } = require('../slack');

function readAnnounceInputs(env) {
  return {
    ...readSharedInputs(env),
    channel: readSlackChannel(env),
    context: readNotificationContext(env),
  };
}

async function announce() {
  try {
    const inputs = readAnnounceInputs(process.env);
    const { channel, context, slackToken } = inputs;
    const finalPurpose = context.tracked_purposes.at(-1);
    const messageArgs = await fetchMessageArgs(inputs, finalPurpose);
    const message = buildProdAnnouncement({ ...messageArgs, finalPurpose });
    await postMessage(slackToken, { channel, ...message });
    notice(`Posted deploy announcement for ${finalPurpose} (${messageArgs.changes.length} change(s)).`);
  } catch (err) {
    warn(`Could not announce deployment: ${err.message}`);
  }
}

if (require.main === module) announce();

module.exports = announce;
