function escapeSlackText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseUserMap(text) {
  if (!text || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    const users = parsed && typeof parsed === 'object' ? parsed.users : null;
    return users && typeof users === 'object' && !Array.isArray(users) ? users : {};
  } catch {
    return {};
  }
}

function resolveMention(userMap, login) {
  if (!login) return 'the author';
  const slackId = userMap[login];
  if (slackId) return `<@${slackId}>`;
  return `@${escapeSlackText(login)}`;
}

function renderLink(url, label) {
  return `<${url}|${label}>`;
}

function renderSubject({ pr, commitUrl, shortSha }) {
  if (pr) {
    return renderLink(pr.url, `#${pr.number} ${escapeSlackText(pr.title)}`);
  }
  if (commitUrl) {
    return renderLink(commitUrl, shortSha);
  }
  return `\`${shortSha}\``;
}

const DEFAULT_TRACKED_PURPOSES = ['dev', 'stage', 'demo', 'prod'];
const DEFAULT_FINAL_PURPOSE = DEFAULT_TRACKED_PURPOSES.at(-1);
const DEFAULT_JOB_NAME_PATTERN = 'deploy ($purpose)';

function parseTrackedPurposes(input = '') {
  const names = input.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  return names.length ? [...new Set(names)] : DEFAULT_TRACKED_PURPOSES;
}

const PURPOSE_STATUS_PRESENTATION = {
  pending: { emoji: ':white_circle:', label: 'queued' },
  awaiting: { emoji: ':large_orange_circle:', label: 'awaiting', phrase: 'awaiting approval' },
  in_progress: { emoji: ':large_yellow_circle:', label: 'deploying' },
  success: { emoji: ':large_green_circle:', label: 'live' },
  failure: { emoji: ':red_circle:', label: 'failed' },
  blocked: { emoji: ':no_entry:', label: 'blocked' },
  cancelled: { emoji: ':black_circle:', label: 'cancelled' },
};

function purposeStatusPresentation(status) {
  return PURPOSE_STATUS_PRESENTATION[status] || PURPOSE_STATUS_PRESENTATION.pending;
}

function purposeStatusPhrase(status) {
  const presentation = purposeStatusPresentation(status);
  return presentation.phrase ?? presentation.label;
}

function normalizePurposeStatus(raw) {
  switch (String(raw ?? '').trim()) {
    case 'awaiting':
      return 'awaiting';
    case 'in_progress':
      return 'in_progress';
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
    case 'blocked':
      return 'blocked';
    default:
      return 'pending';
  }
}

function isTerminalStatus(status) {
  return status === 'success' || status === 'failure' || status === 'blocked' || status === 'cancelled';
}

function resolvePurposeStatuses({ names = DEFAULT_TRACKED_PURPOSES, hints = {}, jobs = {}, awaiting = [] } = {}) {
  const awaitingPurposes = new Set(awaiting || []);
  return names.map((name) => {
    const hint = normalizePurposeStatus(hints[name]);
    const job = Object.hasOwn(jobs, name) ? jobs[name] : null;
    let status = hint;
    let source = 'hint';
    if (isTerminalStatus(hint)) {
      status = hint;
    } else if (job && job.status === 'completed') {
      status = normalizePurposeStatus(job.conclusion);
      source = 'job';
    } else if (awaitingPurposes.has(name)) {
      status = 'awaiting';
      source = 'approval';
    } else if (job && job.status === 'in_progress') {
      status = 'in_progress';
      source = 'job';
    }
    return {
      name,
      status,
      createdAt: job?.createdAt ?? null,
      startedAt: job?.startedAt ?? null,
      completedAt: job?.completedAt ?? null,
      source,
    };
  });
}

function indexPurposeJobs(jobs, names = DEFAULT_TRACKED_PURPOSES, jobNamePattern) {
  const pattern = jobNamePattern?.trim() || DEFAULT_JOB_NAME_PATTERN;
  if (!pattern.includes('$purpose')) return {};
  const purposesByJobName = new Map(names.map((name) => [
    pattern.replaceAll('$purpose', () => name).toLowerCase(),
    name,
  ]));
  const index = new Map();
  for (const job of jobs || []) {
    const separator = ' / ';
    let jobName = String(job?.name ?? '').trim().toLowerCase();
    while (!purposesByJobName.has(jobName) && jobName.includes(separator)) {
      jobName = jobName.slice(0, jobName.lastIndexOf(separator));
    }
    const purpose = purposesByJobName.get(jobName);
    if (purpose === undefined || index.has(purpose)) continue;
    index.set(purpose, {
      status: job.status ?? null,
      conclusion: job.conclusion ?? null,
      createdAt: job.createdAt ?? null,
      startedAt: job.startedAt ?? null,
      completedAt: job.completedAt ?? null,
    });
  }
  return Object.fromEntries(index);
}

function currentStatusHeadline(purposes) {
  const firstWith = (status) => (purposes || []).find((purpose) => purpose.status === status)?.name;

  const failed = firstWith('failure');
  if (failed) return { emoji: ':red_circle:', text: `Failed at ${failed}` };

  const stopped = firstWith('blocked') || firstWith('cancelled');
  if (stopped) return { emoji: ':no_entry:', text: `Stopped at ${stopped}` };

  const deploying = firstWith('in_progress');
  if (deploying) return { emoji: ':large_yellow_circle:', text: `Deploying to ${deploying}` };

  const waiting = firstWith('awaiting');
  if (waiting) return { emoji: ':large_orange_circle:', text: `Approval needed: ${waiting}` };

  if (purposes?.length && purposes.every((purpose) => purpose.status === 'success')) {
    return { emoji: ':white_check_mark:', text: `Live in ${purposes.at(-1).name}` };
  }
  return { emoji: ':rocket:', text: 'Queued' };
}

function formatRepositoryHeadline(repository, headline, version = '') {
  const name = repository?.split('/').at(-1);
  const subject = [name, version.trim()].filter(Boolean).join(' ');
  return subject ? `${subject} ${headline[0].toLowerCase()}${headline.slice(1)}` : headline;
}

function renderHeadlineBlock(emoji, headline) {
  const text = truncateSubject(`${emoji} ${headline}`, 150).toWellFormed();
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderClockTime(iso) {
  const ms = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ms)) return '';
  const fallback = new Date(ms).toISOString().slice(11, 16);
  return `<!date^${Math.floor(ms / 1000)}^{time}|${fallback} UTC>`;
}

function renderPurposeDetail({ status, createdAt, startedAt, completedAt }) {
  if (status === 'success' || status === 'failure' || status === 'cancelled') {
    const started = Date.parse(String(startedAt ?? ''));
    const finished = Date.parse(String(completedAt ?? ''));
    if (!Number.isFinite(started) || !Number.isFinite(finished)) return '';
    return formatDuration(finished - started);
  }
  if (status === 'in_progress') {
    const clock = renderClockTime(startedAt ?? createdAt);
    return clock ? `since ${clock}` : '';
  }
  if (status === 'awaiting') {
    const clock = renderClockTime(createdAt ?? startedAt);
    return clock ? `since ${clock}` : '';
  }
  return '';
}

function renderPurposeFields(purposes) {
  return (purposes || []).flatMap((purpose) => {
    const { emoji, label } = purposeStatusPresentation(purpose.status);
    const detail = renderPurposeDetail(purpose);
    return [
      { type: 'mrkdwn', text: `*${escapeSlackText(purpose.name)}*` },
      { type: 'mrkdwn', text: `${emoji}  ${label}${detail ? `  ·  _${detail}_` : ''}` },
    ];
  });
}

function renderFooter({ runUrl = '', compareUrl = '', commitUrl = null, shortSha = '', releaseUrl = '' }) {
  const parts = [];
  if (runUrl) parts.push(renderLink(runUrl, 'View pipeline'));
  if (compareUrl) parts.push(renderLink(compareUrl, 'Compare'));
  if (releaseUrl) parts.push(renderLink(releaseUrl, 'Release'));
  if (shortSha) parts.push(commitUrl ? renderLink(commitUrl, shortSha) : `\`${shortSha}\``);
  return parts.join('  ·  ');
}

function buildFallbackText({ headline, subjectText, purposes }) {
  const summary = purposes
    .map((purpose) => `${purpose.name}: ${purposeStatusPhrase(purpose.status)}`)
    .join(' · ');
  return `${escapeSlackText(headline)} — ${subjectText}${summary ? ` (${summary})` : ''}`;
}

function subjectPlainText({ pr, shortSha }) {
  if (pr) return `#${pr.number} ${pr.title}`;
  return shortSha || 'this commit';
}

function changeSubject({ release, changes, pr, shortSha }) {
  if (release) return release.url ? renderLink(release.url, 'Release notes') : 'Release notes';
  if (changes.length > 1) return renderChangeCount(changes.length, groupCommitsByAuthor(changes).length);
  return subjectPlainText({ pr, shortSha });
}

function renderChangeCount(commitCount, authorCount) {
  const commits = `${commitCount} ${commitCount === 1 ? 'commit' : 'commits'}`;
  const authors = `${authorCount} ${authorCount === 1 ? 'author' : 'authors'}`;
  return `${commits} from ${authors}`;
}

function renderAuthorGroups({ groups, userMap = {}, repoUrl = '', maxPerAuthor = 5 }) {
  return (groups || [])
    .map((group) => {
      const lines = group.commits
        .slice(0, maxPerAuthor)
        .map((commit) => `    • ${renderCommitRef(commit, repoUrl)}`);
      const overflow = group.commits.length - maxPerAuthor;
      if (overflow > 0) lines.push(`    _+${overflow} more_`);
      return [`${authorLabel(group, userMap)} — ${group.commits.length}`, ...lines].join('\n');
    })
    .join('\n\n');
}

function renderChangeList({ changes, userMap = {}, repoUrl = '', maxPerAuthor = 5 }) {
  if (!changes || changes.length === 0) return null;
  const groups = groupCommitsByAuthor(changes);
  return [
    renderChangeCount(changes.length, groups.length),
    '',
    renderAuthorGroups({ groups, userMap, repoUrl, maxPerAuthor }),
  ].join('\n');
}

function renderReleaseNotes(release) {
  const body = release.body.trim();
  if (!body) return null;
  const limit = 12000;
  const text = body.length > limit ? `${body.slice(0, limit - 1).toWellFormed()}…` : body;
  return { type: 'markdown', text };
}

function buildDeployMessage({
  purposes,
  repository,
  version,
  pr,
  mention,
  runUrl = '',
  commitUrl = null,
  shortSha = '',
  release = null,
  changes = [],
  userMap = {},
  repoUrl = '',
  compareUrl = '',
  maxPerAuthor = 5,
}) {
  const { emoji, text: status } = currentStatusHeadline(purposes);
  const headline = formatRepositoryHeadline(repository, status, version);

  const changeCount = changes.length;

  const blocks = [renderHeadlineBlock(emoji, headline)];
  if (!release && changeCount <= 1) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${renderSubject({ pr, commitUrl, shortSha })}*\n${mention}` },
    });
  }
  const fields = renderPurposeFields(purposes);
  if (fields.length) blocks.push({ type: 'divider' });
  const maxFieldsPerSection = 10;
  for (let offset = 0; offset < fields.length; offset += maxFieldsPerSection) {
    blocks.push({ type: 'section', fields: fields.slice(offset, offset + maxFieldsPerSection) });
  }
  if (release) {
    const notes = renderReleaseNotes(release);
    if (notes) blocks.push({ type: 'divider' }, notes);
  } else if (changeCount > 1) {
    const list = renderChangeList({ changes, userMap, repoUrl, maxPerAuthor });
    if (list) blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: list } });
  }
  const footer = renderFooter({ runUrl, compareUrl, commitUrl, shortSha, releaseUrl: release?.url });
  if (footer) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] });

  const text = buildFallbackText({
    headline,
    subjectText: changeSubject({ release, changes, pr, shortSha }),
    purposes,
  });
  return { text, blocks };
}

function buildProdAnnouncement({
  pr,
  mention,
  repository,
  version,
  finalPurpose = DEFAULT_FINAL_PURPOSE,
  runUrl = '',
  commitUrl = null,
  shortSha = '',
  release = null,
  changes = [],
  userMap = {},
  repoUrl = '',
  compareUrl = '',
  maxPerAuthor = 5,
}) {
  const changeCount = changes.length;
  const destination = finalPurpose === DEFAULT_FINAL_PURPOSE ? 'production' : finalPurpose;
  const headline = formatRepositoryHeadline(repository, `Shipped to ${destination}`, version);
  const blocks = [renderHeadlineBlock(':rocket:', headline)];
  if (release) {
    const notes = renderReleaseNotes(release);
    if (notes) blocks.push(notes);
  } else if (changeCount > 1) {
    const list = renderChangeList({ changes, userMap, repoUrl, maxPerAuthor });
    if (list) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: list } });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${renderSubject({ pr, commitUrl, shortSha })}*\n${mention}` },
    });
  }
  const footer = renderFooter({ runUrl, compareUrl, commitUrl, shortSha, releaseUrl: release?.url });
  if (footer) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] });
  const subjectText = changeSubject({ release, changes, pr, shortSha });
  const text = `${escapeSlackText(headline)} — ${subjectText}`;
  return { text, blocks };
}

function localHourInTimeZone(date, timeZone) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  const hour = Number(formatted);
  return hour === 24 ? 0 : hour;
}

function parseCronTime(schedule) {
  const fields = String(schedule ?? '').trim().split(/\s+/);
  if (fields.length < 2) return null;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return { hour, minute };
}

function shouldRunForSchedule({ schedule, date, timeZone, targetHour, force = false }) {
  if (force) return true;
  const cron = parseCronTime(schedule);
  if (!cron) return true;
  const intended = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), cron.hour, cron.minute),
  );
  return localHourInTimeZone(intended, timeZone) === targetHour;
}

function isAutomatedCommit({ login = '', subject = '' } = {}) {
  if (login && login.endsWith('[bot]')) return true;
  return /\[changelog-assembly]/.test(subject);
}

function parsePrNumber(subject) {
  const text = String(subject ?? '');
  const trailing = text.match(/\(#(\d+)\)\s*$/);
  if (trailing) return Number(trailing[1]);
  const anywhere = text.match(/#(\d+)/);
  return anywhere ? Number(anywhere[1]) : null;
}

function truncateSubject(subject, max = 100) {
  const line = String(subject ?? '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function selectUndeployedCommits(commits, { nowMs, graceMs = 0 } = {}) {
  return (commits || []).filter((commit) => {
    if (isAutomatedCommit(commit)) return false;
    if (graceMs > 0 && commit.committedAt) {
      const ageMs = nowMs - Date.parse(commit.committedAt);
      if (Number.isFinite(ageMs) && ageMs < graceMs) return false;
    }
    return true;
  });
}

function groupCommitsByAuthor(commits) {
  const groups = new Map();
  for (const commit of commits || []) {
    const key = commit.login || `name:${commit.authorName || 'unknown'}`;
    let group = groups.get(key);
    if (!group) {
      group = { login: commit.login || null, authorName: commit.authorName || null, commits: [] };
      groups.set(key, group);
    }
    group.commits.push(commit);
  }
  return [...groups.values()].sort((a, b) => b.commits.length - a.commits.length);
}

function authorLabel(group, userMap) {
  if (group.login) return resolveMention(userMap, group.login);
  if (group.authorName) return `*${escapeSlackText(group.authorName)}*`;
  return 'an unknown author';
}

function renderCommitRef({ prNumber, htmlUrl, shortSha, subject }, repoUrl = '') {
  const cleaned = prNumber ? String(subject ?? '').replace(/\s*\(#\d+\)\s*$/, '') : subject;
  const label = escapeSlackText(truncateSubject(cleaned));
  if (prNumber) {
    const prUrl = repoUrl ? `${repoUrl}/pull/${prNumber}` : htmlUrl;
    return prUrl ? renderLink(prUrl, `#${prNumber} ${label}`) : `#${prNumber} ${label}`;
  }
  if (htmlUrl) return renderLink(htmlUrl, `${shortSha} ${label}`);
  return `\`${shortSha}\` ${label}`;
}

function buildDigestText({
  groups,
  repository,
  finalPurpose = DEFAULT_FINAL_PURPOSE,
  userMap = {},
  repoUrl = '',
  compareUrl = '',
  deployedShaShort = '',
  maxPerAuthor = 5,
}) {
  const destination = escapeSlackText(finalPurpose);
  const totalCommits = groups.reduce((sum, group) => sum + group.commits.length, 0);
  const since =
    compareUrl && deployedShaShort
      ? `_since ${renderLink(compareUrl, deployedShaShort)}, the last ${destination} deploy_`
      : '';

  const headline = formatRepositoryHeadline(repository, 'Undeployed changes on `main`');
  const header = [
    `:package: *${escapeSlackText(headline)}*`,
    `${renderChangeCount(totalCommits, groups.length)}, merged but not yet live in ${destination}`,
    since,
  ].filter(Boolean);

  const footer =
    `_On \`main\` but not yet in ${destination} — a deploy may have failed or is still pending._`;

  return [
    ...header,
    '',
    renderAuthorGroups({ groups, userMap, repoUrl, maxPerAuthor }),
    '',
    footer,
  ].join('\n');
}

module.exports = {
  escapeSlackText,
  parseUserMap,
  resolveMention,
  renderSubject,
  DEFAULT_TRACKED_PURPOSES,
  DEFAULT_FINAL_PURPOSE,
  parseTrackedPurposes,
  PURPOSE_STATUS_PRESENTATION,
  purposeStatusPresentation,
  purposeStatusPhrase,
  normalizePurposeStatus,
  isTerminalStatus,
  resolvePurposeStatuses,
  indexPurposeJobs,
  currentStatusHeadline,
  formatDuration,
  renderClockTime,
  renderPurposeDetail,
  renderPurposeFields,
  renderFooter,
  renderChangeCount,
  renderAuthorGroups,
  renderChangeList,
  buildDeployMessage,
  buildProdAnnouncement,
  localHourInTimeZone,
  parseCronTime,
  shouldRunForSchedule,
  isAutomatedCommit,
  parsePrNumber,
  truncateSubject,
  selectUndeployedCommits,
  groupCommitsByAuthor,
  authorLabel,
  renderCommitRef,
  buildDigestText,
};
