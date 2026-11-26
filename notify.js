const {
  resolveMention,
  buildDeployMessage,
  resolvePurposeStatuses,
  indexPurposeJobs,
  isAutomatedCommit,
} = require('./lib');
const {
  createLogger,
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

async function fetchMessageArgs(inputs, finalPurpose) {
  const {
    repository, version, serverUrl, runId, workspace, userMapPath, commitSha, workflowFile, runSha, githubToken,
  } = inputs;
  const repoUrl = `${serverUrl}/${repository}`;
  const runUrl = runId ? `${repoUrl}/actions/runs/${runId}` : '';
  const shortSha = commitSha.slice(0, 7);
  const commitUrl = commitSha ? `${repoUrl}/commit/${commitSha}` : null;

  const pr = await fetchPrForCommit({
    repository,
    sha: commitSha,
    token: githubToken,
  });
  const userMap = readUserMap(workspace, userMapPath);
  const mention = resolveMention(userMap, pr?.author);

  const { changes, base } = await fetchDeployChanges({
    repository,
    workflowFile,
    finalPurpose,
    commitSha,
    runSha,
    token: githubToken,
  });
  const compareUrl = base ? `${repoUrl}/compare/${base.slice(0, 7)}...${shortSha}` : '';
  return {
    repository, version, pr, mention, runUrl, commitUrl, shortSha, changes, userMap, repoUrl, compareUrl,
  };
}

async function fetchStatusMessage(inputs, names) {
  const { repository, runId, githubToken, inputPurpose, status, jobNamePattern } = inputs;
  const messageArgs = await fetchMessageArgs(inputs, names.at(-1));
  const purpose = inputPurpose.trim().toLowerCase();
  const purposes = await fetchPurposes({
    repository,
    runId,
    token: githubToken,
    names,
    hints: purpose && status ? { [purpose]: status } : {},
    jobNamePattern,
  });
  const message = buildDeployMessage({ ...messageArgs, purposes });
  const summary = purposes.map((purpose) => `${purpose.name}=${purpose.status}`).join(' ');
  return { message, summary };
}

module.exports = {
  fetchMessageArgs,
  fetchStatusMessage,
  notice,
  warn,
};
