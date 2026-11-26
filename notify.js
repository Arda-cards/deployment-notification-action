const { appendFileSync } = require('node:fs');
const {
  resolveMention,
  buildDeployMessage,
  buildProdAnnouncement,
  resolvePurposeStatuses,
  indexPurposeJobs,
  isAutomatedCommit,
  parseTrackedPurposes,
} = require('./lib');
const {
  createLogger,
  slackCall,
  githubApi,
  readUserMap,
  lastSuccessfulDeploySha,
  compareCommits,
  runJobs,
  awaitingApprovalPurposes,
} = require('./io');

const { warn, notice } = createLogger('deploy-slack-notify');

const CONFIRM_ATTEMPTS = 5;
const CONFIRM_DELAY_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${name}=${value}\n`);
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

function readNotificationContext(input) {
  if (!input.trim()) throw new Error('No context was provided from the post action.');
  let context;
  try {
    context = JSON.parse(input);
  } catch {
    throw new Error('context must be valid JSON from the post action.');
  }
  return validateNotificationContext(context);
}

async function fetchPrForCommit({ repository, sha, token }) {
  if (!sha) return null;
  const prs = await githubApi(`/repos/${repository}/commits/${sha}/pulls`, token, { warn });
  if (!Array.isArray(prs) || prs.length === 0) return null;
  const pr = prs[0];
  return {
    number: pr.number,
    title: pr.title ?? '',
    url: pr.html_url,
    author: pr.user?.login ?? null,
  };
}

async function fetchPurposes({ repository, runId, token, names, hints, jobNamePattern }) {
  let purposes = resolvePurposeStatuses({ names, hints });
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    const [jobs, awaiting] = await Promise.all([
      runJobs({ repository, runId, token, warn }),
      awaitingApprovalPurposes({ repository, runId, token, warn }),
    ]);
    purposes = resolvePurposeStatuses({ names, hints, jobs: indexPurposeJobs(jobs, names, jobNamePattern), awaiting });
    const unconfirmed = purposes.some(
      (purpose) => purpose.status === 'in_progress' && purpose.source === 'hint',
    );
    if (!unconfirmed) break;
    if (attempt < CONFIRM_ATTEMPTS) await sleep(CONFIRM_DELAY_MS);
  }
  return purposes;
}

async function fetchDeployChanges({ repository, workflowFile, finalPurpose, commitSha, runSha, token }) {
  if (!commitSha) return { changes: [], base: null };
  const base = await lastSuccessfulDeploySha({
    repository,
    workflowFile,
    purpose: finalPurpose,
    excludeShas: [commitSha, runSha].filter(Boolean),
    token,
    warn,
  });
  if (!base) return { changes: [], base: null };
  const raw = await compareCommits({ repository, base, head: commitSha, token, warn });
  const changes = raw
    .filter((commit) => !isAutomatedCommit({ login: commit.login, subject: commit.subject }))
    .reverse();
  return { changes, base };
}

async function main(mode) {
  const env = process.env;
  const {
    INPUT_VERSION: version,
    INPUT_JOBNAMEPATTERN: jobNamePattern,
    INPUT_PURPOSE: inputPurpose = env.PURPOSE ?? '',
    INPUT_STATUS: status = env.STATUS ?? 'pending',
    INPUT_CONTEXT: inputContext = env.CONTEXT ?? '',
    'INPUT_COMMIT-SHA': inputSha = env.COMMIT_SHA ?? '',
    'INPUT_SLACK-BOT-TOKEN': slackToken = env.SLACK_BOT_TOKEN,
    'INPUT_SLACK-CHANNEL': slackChannel = env.SLACK_CHANNEL,
    'INPUT_GITHUB-TOKEN': githubToken = env.GITHUB_TOKEN,
    'INPUT_USER-MAP-PATH': userMapPath = env.USER_MAP_PATH ?? '.github/deploy-notify/user-map.json',
    DEPLOY_WORKFLOW = 'deploy.yaml',
    GITHUB_REPOSITORY: repository = env.REPOSITORY,
    GITHUB_SERVER_URL: serverUrl = env.SERVER_URL ?? 'https://github.com',
    GITHUB_RUN_ID: runId = env.RUN_ID ?? '',
    GITHUB_WORKSPACE = process.cwd(),
  } = env;

  if (!slackToken) {
    warn('slack-bot-token is required — skipping deploy notification.');
    return;
  }
  if (mode !== 'update' && !slackChannel) {
    warn('slack-channel is required — skipping deploy notification.');
    return;
  }

  const context = mode === 'post' ? null : readNotificationContext(inputContext);
  const names = context?.tracked_purposes ?? parseTrackedPurposes(env['INPUT_TRACKED-PURPOSE'] ?? env.TRACKED_PURPOSES);
  const finalPurpose = names.at(-1);
  const commitSha = inputSha || env.GITHUB_SHA || '';
  const repoUrl = `${serverUrl}/${repository}`;
  const runUrl = runId ? `${repoUrl}/actions/runs/${runId}` : '';
  const shortSha = commitSha.slice(0, 7);
  const commitUrl = commitSha ? `${repoUrl}/commit/${commitSha}` : null;

  const pr = await fetchPrForCommit({
    repository,
    sha: commitSha,
    token: githubToken,
  });
  const userMap = readUserMap(GITHUB_WORKSPACE, userMapPath);
  const mention = resolveMention(userMap, pr?.author);

  const { changes, base } = await fetchDeployChanges({
    repository,
    workflowFile: DEPLOY_WORKFLOW,
    finalPurpose,
    commitSha,
    runSha: env.GITHUB_SHA,
    token: githubToken,
  });
  const compareUrl = base ? `${repoUrl}/compare/${base.slice(0, 7)}...${shortSha}` : '';
  const messageArgs = {
    repository, version, pr, mention, runUrl, commitUrl, shortSha, changes, userMap, repoUrl, compareUrl,
  };

  if (mode === 'announce') {
    const { text, blocks } = buildProdAnnouncement({ ...messageArgs, finalPurpose });
    await slackCall('chat.postMessage', slackToken, {
      channel: slackChannel,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    notice(`Posted deploy announcement for ${finalPurpose} (${changes.length} change(s)).`);
    return;
  }

  const purpose = inputPurpose.trim().toLowerCase();
  const purposes = await fetchPurposes({
    repository,
    runId,
    token: githubToken,
    names,
    hints: purpose && status ? { [purpose]: status } : {},
    jobNamePattern,
  });
  const { text, blocks } = buildDeployMessage({ ...messageArgs, purposes });
  const statusSummary = purposes.map((purpose) => `${purpose.name}=${purpose.status}`).join(' ');

  if (mode === 'post') {
    const res = await slackCall('chat.postMessage', slackToken, {
      channel: slackChannel,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    const postedContext = validateNotificationContext({
      channel_id: res.channel,
      message_ts: res.ts,
      tracked_purposes: names,
    });
    setOutput('context', JSON.stringify(postedContext));
    notice(`Posted deploy status message (ts=${res.ts}): ${statusSummary}`);
    return;
  }

  await slackCall('chat.update', slackToken, {
    channel: context.channel_id,
    ts: context.message_ts,
    text,
    blocks,
  });
  notice(`Updated deploy status message: ${statusSummary}`);
}

function runNotification(mode) {
  if (!['post', 'update', 'announce'].includes(mode)) {
    warn(`Unknown notification mode "${mode}" — expected "post", "update", or "announce".`);
    return;
  }
  return main(mode).catch((err) => {
    warn(`Deploy notification error: ${err.message}`);
  });
}

if (require.main === module) {
  runNotification(process.env.INPUT_MODE ?? process.env.MODE ?? 'update');
}

module.exports = { runNotification };
