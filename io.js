const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DEFAULT_FINAL_PURPOSE, parseUserMap, parsePrNumber } = require('./lib');

const DEFAULT_BRANCH = 'main';

function createLogger(title) {
  return {
    warn: (message) => console.log(`::warning title=${title}::${message}`),
    notice: (message) => console.log(`::notice::${message}`),
  };
}

async function githubApi(path, token, { warn = () => {}, userAgent = 'arda-deploy-notify' } = {}) {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': userAgent,
      },
    });
    if (!res.ok) {
      warn(`GitHub API ${path} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    warn(`GitHub API ${path} failed: ${err.message}`);
    return null;
  }
}

function readUserMap(workspace, relativePath) {
  try {
    return parseUserMap(readFileSync(join(workspace, relativePath), 'utf8'));
  } catch {
    return {};
  }
}

const FRONTIER_LOOKBACK = 20;

async function lastSuccessfulPurposeSha({ repository, purpose, excludeShas = [], token, warn }) {
  const encodedPurpose = encodeURIComponent(purpose);
  const deployments = await githubApi(
    `/repos/${repository}/deployments?environment=${encodedPurpose}&per_page=${FRONTIER_LOOKBACK}`,
    token,
    { warn },
  );
  if (!Array.isArray(deployments)) return null;
  for (const deployment of deployments) {
    if (excludeShas.includes(deployment.sha)) continue;
    const statuses = await githubApi(
      `/repos/${repository}/deployments/${deployment.id}/statuses?per_page=1`,
      token,
      { warn },
    );
    if (statuses?.[0]?.state === 'success') return deployment.sha;
  }
  return null;
}

async function lastSuccessfulRunSha({ repository, workflowFile, branch, excludeShas = [], token, warn }) {
  const data = await githubApi(
    `/repos/${repository}/actions/workflows/${workflowFile}/runs?status=success&per_page=${FRONTIER_LOOKBACK}`,
    token,
    { warn },
  );
  const run = (data?.workflow_runs || []).find(
    (candidate) => candidate.head_branch === branch && !excludeShas.includes(candidate.head_sha),
  );
  return run?.head_sha || null;
}

async function lastSuccessfulDeploySha({
  repository,
  workflowFile,
  purpose = DEFAULT_FINAL_PURPOSE,
  branch = DEFAULT_BRANCH,
  excludeShas = [],
  token,
  warn = () => {},
}) {
  return (
    (await lastSuccessfulPurposeSha({ repository, purpose, excludeShas, token, warn })) ||
    (await lastSuccessfulRunSha({ repository, workflowFile, branch, excludeShas, token, warn }))
  );
}

async function compareCommits({ repository, base, head = DEFAULT_BRANCH, token, warn = () => {} }) {
  const data = await githubApi(`/repos/${repository}/compare/${base}...${head}`, token, { warn });
  if (!data || !Array.isArray(data.commits)) return [];
  return data.commits.map((entry) => {
    const subject = String(entry.commit?.message || '').split('\n')[0];
    return {
      sha: entry.sha,
      shortSha: String(entry.sha).slice(0, 7),
      login: entry.author?.login || null,
      authorName: entry.commit?.author?.name || null,
      subject,
      committedAt: entry.commit?.committer?.date || entry.commit?.author?.date || null,
      htmlUrl: entry.html_url || null,
      prNumber: parsePrNumber(subject),
    };
  });
}

async function runJobs({ repository, runId, token, warn = () => {} }) {
  if (!runId) return [];
  const data = await githubApi(
    `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
    token,
    { warn },
  );
  if (!data || !Array.isArray(data.jobs)) return [];
  return data.jobs.map((job) => ({
    name: job.name ?? '',
    status: job.status ?? null,
    conclusion: job.conclusion ?? null,
    createdAt: job.created_at ?? null,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
  }));
}

async function awaitingApprovalPurposes({ repository, runId, token, warn = () => {} }) {
  if (!runId) return [];
  const data = await githubApi(
    `/repos/${repository}/actions/runs/${runId}/pending_deployments`,
    token,
    { warn },
  );
  if (!Array.isArray(data)) return [];
  return data
    .map((pending) => String(pending?.environment?.name ?? '').toLowerCase())
    .filter(Boolean);
}

module.exports = {
  DEFAULT_BRANCH,
  createLogger,
  githubApi,
  readUserMap,
  lastSuccessfulDeploySha,
  compareCommits,
  runJobs,
  awaitingApprovalPurposes,
};
