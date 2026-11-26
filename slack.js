async function slackCall(method, token, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack ${method} error: ${data.error || res.status}`);
  }
  return data;
}

function postMessage(token, message) {
  return slackCall('chat.postMessage', token, {
    ...message,
    unfurl_links: false,
    unfurl_media: false,
  });
}

function updateMessage(token, message) {
  return slackCall('chat.update', token, message);
}

module.exports = { postMessage, updateMessage };
