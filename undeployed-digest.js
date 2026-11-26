const {
  shouldRunForSchedule,
  selectUndeployedCommits,
  groupCommitsByAuthor,
  buildDigestText,
  parseTrackedPurposes,
} = require('./lib');
const {
  DEFAULT_BRANCH,
  createLogger,
  readUserMap,
  lastSuccessfulDeploySha,
  compareCommits,
} = require('./io');
const { postMessage } = require('./slack');

const { warn, notice } = createLogger('undeployed-digest');

async function main() {
  const {
    SLACK_BOT_TOKEN,
    SLACK_CHANNEL,
    GITHUB_TOKEN,
    REPOSITORY,
    SERVER_URL = 'https://github.com',
    USER_MAP_PATH = '.github/deploy-notify/user-map.json',
    DEPLOY_WORKFLOW = 'deploy.yaml',
    TRACKED_PURPOSES,
    GRACE_MINUTES = '90',
    TARGET_TZ = 'America/Los_Angeles',
    TARGET_HOUR = '9',
    SCHEDULE = '',
    EVENT_NAME = '',
    GITHUB_WORKSPACE = process.cwd(),
  } = process.env;

  const force = EVENT_NAME === 'workflow_dispatch';
  if (
    !shouldRunForSchedule({
      schedule: SCHEDULE,
      date: new Date(),
      timeZone: TARGET_TZ,
      targetHour: Number(TARGET_HOUR),
      force,
    })
  ) {
    notice(
      `Cron "${SCHEDULE}" does not land in hour ${TARGET_HOUR} of ${TARGET_TZ} today` +
        ' — the other cron owns this slot; skipping.',
    );
    return;
  }

  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL) {
    warn('SLACK_DEPLOY_BOT_TOKEN and/or SLACK_DEPLOY_CHANNEL are not set — skipping digest.');
    return;
  }
  if (!GITHUB_TOKEN || !REPOSITORY) {
    warn('GITHUB_TOKEN and/or repository are not available — skipping digest.');
    return;
  }

  const finalPurpose = parseTrackedPurposes(TRACKED_PURPOSES).at(-1);
  const base = await lastSuccessfulDeploySha({
    repository: REPOSITORY,
    workflowFile: DEPLOY_WORKFLOW,
    purpose: finalPurpose,
    token: GITHUB_TOKEN,
    warn,
  });
  if (!base) {
    warn(`Could not find a successful ${finalPurpose} deploy to compare against — skipping digest.`);
    return;
  }

  const graceMs = Number(GRACE_MINUTES) * 60 * 1000;
  const commits = await compareCommits({ repository: REPOSITORY, base, token: GITHUB_TOKEN, warn });
  const undeployed = selectUndeployedCommits(commits, { nowMs: Date.now(), graceMs });

  if (undeployed.length === 0) {
    notice('Nothing on main is waiting to deploy — staying silent.');
    return;
  }

  const groups = groupCommitsByAuthor(undeployed);
  const repoUrl = `${SERVER_URL}/${REPOSITORY}`;
  const shortBase = base.slice(0, 7);
  const text = buildDigestText({
    groups,
    repository: REPOSITORY,
    finalPurpose,
    userMap: readUserMap(GITHUB_WORKSPACE, USER_MAP_PATH),
    repoUrl,
    compareUrl: `${repoUrl}/compare/${shortBase}...${DEFAULT_BRANCH}`,
    deployedShaShort: shortBase,
  });

  await postMessage(SLACK_BOT_TOKEN, { channel: SLACK_CHANNEL, text });
  notice(`Posted undeployed digest: ${undeployed.length} commit(s) from ${groups.length} author(s).`);
}

main().catch((err) => {
  warn(`Undeployed digest error: ${err.message}`);
});
