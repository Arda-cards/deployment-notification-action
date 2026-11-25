const {
  localHourInTimeZone,
  parseCronTime,
  shouldRunForSchedule,
  isAutomatedCommit,
  parsePrNumber,
  truncateSubject,
  selectUndeployedCommits,
  groupCommitsByAuthor,
  authorLabel,
  buildDigestText,
} = require('./lib');

describe('localHourInTimeZone / parseCronTime / shouldRunForSchedule', () => {
  const tz = 'America/Los_Angeles';

  it('reads the wall-clock hour in the target zone across DST', () => {
    expect(localHourInTimeZone(new Date('2026-07-30T16:30:00Z'), tz)).toBe(9);
    expect(localHourInTimeZone(new Date('2026-07-30T17:30:00Z'), tz)).toBe(10);
    expect(localHourInTimeZone(new Date('2026-01-15T16:30:00Z'), tz)).toBe(8);
    expect(localHourInTimeZone(new Date('2026-01-15T17:30:00Z'), tz)).toBe(9);
  });

  it('reads the hour and minute out of a cron expression', () => {
    expect(parseCronTime('30 16 * * *')).toEqual({ hour: 16, minute: 30 });
    expect(parseCronTime('  0 7 * * 1-5 ')).toEqual({ hour: 7, minute: 0 });
    expect(parseCronTime('*/5 * * * *')).toBeNull();
    expect(parseCronTime('')).toBeNull();
    expect(parseCronTime(undefined)).toBeNull();
  });

  it('runs only the cron that is the target local hour that day', () => {
    const on = (iso, schedule) =>
      shouldRunForSchedule({ schedule, date: new Date(iso), timeZone: tz, targetHour: 9 });
    expect(on('2026-07-30T16:30:00Z', '30 16 * * *')).toBe(true);
    expect(on('2026-07-30T17:30:00Z', '30 17 * * *')).toBe(false);
    expect(on('2026-01-15T16:30:00Z', '30 16 * * *')).toBe(false);
    expect(on('2026-01-15T17:30:00Z', '30 17 * * *')).toBe(true);
  });

  it('still runs when GitHub starts the job late (the old hour check did not)', () => {
    expect(
      shouldRunForSchedule({
        schedule: '30 16 * * *',
        date: new Date('2026-07-30T17:57:00Z'),
        timeZone: tz,
        targetHour: 9,
      }),
    ).toBe(true);
    expect(
      shouldRunForSchedule({
        schedule: '30 17 * * *',
        date: new Date('2026-07-30T18:57:00Z'),
        timeZone: tz,
        targetHour: 9,
      }),
    ).toBe(false);
  });

  it('runs when forced, and when the schedule is unknown (silence is worse)', () => {
    expect(
      shouldRunForSchedule({
        schedule: '30 17 * * *',
        date: new Date('2026-07-30T03:00:00Z'),
        timeZone: tz,
        targetHour: 9,
        force: true,
      }),
    ).toBe(true);
    expect(
      shouldRunForSchedule({ schedule: '', date: new Date('2026-07-30T03:00:00Z'), timeZone: tz, targetHour: 9 }),
    ).toBe(true);
  });
});

describe('isAutomatedCommit', () => {
  it('flags bot authors and changelog-assembly commits', () => {
    expect(isAutomatedCommit({ login: 'github-actions[bot]', subject: 'anything' })).toBe(true);
    expect(isAutomatedCommit({ login: 'dependabot[bot]', subject: 'bump' })).toBe(true);
    expect(
      isAutomatedCommit({ login: 'octocat', subject: 'chore: assemble CHANGELOG [changelog-assembly]' }),
    ).toBe(true);
  });

  it('keeps ordinary human commits', () => {
    expect(isAutomatedCommit({ login: 'octocat', subject: 'feat: add thing (#12)' })).toBe(false);
    expect(isAutomatedCommit({})).toBe(false);
  });
});

describe('parsePrNumber', () => {
  it('prefers the trailing squash-merge (#N)', () => {
    expect(parsePrNumber('feat: add thing (#1234)')).toBe(1234);
    expect(parsePrNumber('fix: #99 and also (#1234)')).toBe(1234);
  });

  it('falls back to a bare #N, else null', () => {
    expect(parsePrNumber('revert of #77')).toBe(77);
    expect(parsePrNumber('no pr here')).toBeNull();
    expect(parsePrNumber('')).toBeNull();
  });
});

describe('truncateSubject', () => {
  it('keeps the first line and bounds the length', () => {
    expect(truncateSubject('one line')).toBe('one line');
    expect(truncateSubject('first\nsecond')).toBe('first');
    expect(truncateSubject('x'.repeat(80), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('leaves a real conventional-commit subject intact by default', () => {
    const real = 'feat(items): create kanban-generator captures on sign-in (PDEV-1229, PDEV-1340)';
    expect(truncateSubject(real)).toBe(real);
    expect(truncateSubject('y'.repeat(120))).toBe(`${'y'.repeat(99)}…`);
  });
});

describe('selectUndeployedCommits', () => {
  const nowMs = Date.parse('2026-07-30T18:00:00Z');
  const base = { login: 'octocat', subject: 'feat: thing (#1)' };

  it('drops automated commits and anything inside the grace window', () => {
    const commits = [
      { ...base, sha: 'a', committedAt: '2026-07-30T12:00:00Z' },
      { ...base, sha: 'b', committedAt: '2026-07-30T17:50:00Z' },
      {
        login: 'github-actions[bot]',
        subject: 'assemble [changelog-assembly]',
        sha: 'c',
        committedAt: '2026-07-30T01:00:00Z',
      },
    ];
    const kept = selectUndeployedCommits(commits, { nowMs, graceMs: 90 * 60 * 1000 });
    expect(kept.map((c) => c.sha)).toEqual(['a']);
  });

  it('keeps everything human when grace is zero', () => {
    const commits = [
      { ...base, sha: 'a', committedAt: '2026-07-30T17:59:00Z' },
      { ...base, sha: 'b', committedAt: '2026-07-30T17:59:30Z' },
    ];
    expect(selectUndeployedCommits(commits, { nowMs, graceMs: 0 })).toHaveLength(2);
  });
});

describe('groupCommitsByAuthor', () => {
  it('groups by login, busiest author first', () => {
    const groups = groupCommitsByAuthor([
      { login: 'alice', subject: 'a1' },
      { login: 'bob', subject: 'b1' },
      { login: 'alice', subject: 'a2' },
    ]);
    expect(groups.map((g) => [g.login, g.commits.length])).toEqual([
      ['alice', 2],
      ['bob', 1],
    ]);
  });

  it('groups login-less commits by author name', () => {
    const groups = groupCommitsByAuthor([{ login: null, authorName: 'Nobody', subject: 'x' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ login: null, authorName: 'Nobody' });
  });
});

describe('authorLabel', () => {
  it('mentions a known login, else bolds the plain name, else falls back', () => {
    expect(authorLabel({ login: 'alice', authorName: 'Alice' }, { alice: 'U1' })).toBe('<@U1>');
    expect(authorLabel({ login: 'alice', authorName: 'Alice' }, {})).toBe('@alice');
    expect(authorLabel({ login: null, authorName: 'No <Account>' }, {})).toBe('*No &lt;Account&gt;*');
    expect(authorLabel({ login: null, authorName: null }, {})).toBe('an unknown author');
  });
});

describe('buildDigestText', () => {
  it('names the configured final purpose in the digest', () => {
    const text = buildDigestText({
      groups: [],
      repository: 'Arda-cards/arda-frontend-app',
      finalPurpose: 'release',
      compareUrl: 'https://github.com/org/repo/compare/1234567...main',
      deployedShaShort: '1234567',
    });
    expect(text).toContain(':package: *arda-frontend-app undeployed changes on `main`*');
    expect(text).toContain('merged but not yet live in release');
    expect(text).toContain('the last release deploy');
    expect(text).toContain('On `main` but not yet in release');
  });

  const groups = [
    {
      login: 'alice',
      authorName: 'Alice',
      commits: [
        { prNumber: 12, htmlUrl: 'https://gh/c/aaa', shortSha: 'aaaaaaa', subject: 'feat: A (#12)' },
        { prNumber: null, htmlUrl: 'https://gh/c/bbb', shortSha: 'bbbbbbb', subject: 'fix: B' },
      ],
    },
    {
      login: null,
      authorName: 'No Account',
      commits: [{ prNumber: null, htmlUrl: 'https://gh/c/ccc', shortSha: 'ccccccc', subject: 'chore: C' }],
    },
  ];

  it('summarizes totals, mentions, PR + commit links', () => {
    const text = buildDigestText({
      groups,
      userMap: { alice: 'U1' },
      repoUrl: 'https://github.com/org/repo',
      compareUrl: 'https://github.com/org/repo/compare/1234567...main',
      deployedShaShort: '1234567',
    });
    expect(text.split('\n').slice(0, 3)).toEqual([
      ':package: *Undeployed changes on `main`*',
      '3 commits from 2 authors, merged but not yet live in prod',
      '_since <https://github.com/org/repo/compare/1234567...main|1234567>, the last prod deploy_',
    ]);
    expect(text).toContain('<@U1> — 2\n    • ');
    expect(text).toContain('<https://github.com/org/repo/pull/12|#12 feat: A>');
    expect(text).toContain('<https://gh/c/bbb|bbbbbbb fix: B>');
    expect(text).toContain('*No Account* — 1\n    • ');
  });

  it('singularizes and collapses long lists with "+N more"', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      prNumber: i,
      htmlUrl: `https://gh/c/${i}`,
      shortSha: `sha${i}`,
      subject: `s${i} (#${i})`,
    }));
    const text = buildDigestText({
      groups: [{ login: 'solo', authorName: 'Solo', commits: [many[0]] }],
      userMap: {},
    });
    expect(text).toContain('1 commit from 1 author, merged but not yet live in prod');

    const overflow = buildDigestText({
      groups: [{ login: 'solo', authorName: 'Solo', commits: many }],
      userMap: {},
      maxPerAuthor: 5,
    });
    expect(overflow).toContain('    _+2 more_');
  });
});
