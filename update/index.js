const { readNotificationContext, readSharedInputs, readStatusInputs } = require('../context');
const { fetchStatusMessage, notice, warn } = require('../notify');
const { updateMessage } = require('../slack');

function readUpdateInputs() {
  return {
    ...readSharedInputs(),
    ...readStatusInputs(),
    context: readNotificationContext(),
  };
}

async function update() {
  try {
    const inputs = readUpdateInputs();
    const { context, slackToken } = inputs;
    const { version, jobNamePattern, 'user-map-path': userMapPath } = context;
    const { message, summary } = await fetchStatusMessage(
      { ...inputs, version, jobNamePattern, userMapPath },
      context.tracked_purposes,
    );
    await updateMessage(slackToken, {
      channel: context.channel_id,
      ts: context.message_ts,
      ...message,
    });
    notice(`Updated deploy status message: ${summary}`);
  } catch (err) {
    warn(`Could not update deployment status: ${err.message}`);
  }
}

if (require.main === module) update();

module.exports = update;
