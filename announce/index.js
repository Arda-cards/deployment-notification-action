const { readNotificationContext, readSharedInputs } = require('../context');
const { buildProdAnnouncement } = require('../lib');
const { fetchMessageArgs, notice, warn } = require('../notify');
const { postMessage } = require('../slack');

function readAnnounceInputs() {
  return {
    ...readSharedInputs(),
    context: readNotificationContext(),
  };
}

async function announce() {
  try {
    const inputs = readAnnounceInputs();
    const { context, slackToken } = inputs;
    const { version, 'user-map-path': userMapPath, 'slack-channel': channel } = context;
    const finalPurpose = context.tracked_purposes.at(-1);
    const messageArgs = await fetchMessageArgs({ ...inputs, version, userMapPath }, finalPurpose);
    const message = buildProdAnnouncement({ ...messageArgs, finalPurpose });
    await postMessage(slackToken, { channel, ...message });
    const content = messageArgs.release ? 'GitHub release' : `${messageArgs.changes.length} change(s)`;
    notice(`Posted deploy announcement for ${finalPurpose} (${content}).`);
  } catch (err) {
    warn(`Could not announce deployment: ${err.message}`);
  }
}

if (require.main === module) announce();

module.exports = announce;
