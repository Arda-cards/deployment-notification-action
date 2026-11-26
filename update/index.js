const { readNotificationContext, readSharedInputs, readStatusInputs } = require('../context');
const { fetchStatusMessage, notice, warn } = require('../notify');
const { updateMessage } = require('../slack');

function readUpdateInputs(env) {
  return {
    ...readSharedInputs(env),
    ...readStatusInputs(env),
    context: readNotificationContext(env),
  };
}

async function update() {
  try {
    const inputs = readUpdateInputs(process.env);
    const { context, slackToken } = inputs;
    const { message, summary } = await fetchStatusMessage(inputs, context.tracked_purposes);
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
