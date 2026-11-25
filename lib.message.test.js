const {
  escapeSlackText,
  parseUserMap,
  resolveMention,
  renderSubject,
  formatDuration,
  renderClockTime,
  renderPurposeDetail,
  renderPurposeFields,
  renderFooter,
  renderChangeCount,
  renderChangeList,
  buildDeployMessage,
  buildProdAnnouncement,
} = require('./lib');

const sampleChanges = [
  {
    shortSha: 'aaa1111',
    login: 'alice',
    authorName: 'Alice',
    subject: 'Fix scan URL prompt (#1042)',
    prNumber: 1042,
    htmlUrl: 'https://gh/c/aaa1111',
  },
  {
    shortSha: 'bbb2222',
    login: 'bob',
    authorName: 'Bob',
    subject: 'Order queue tooltip (#1039)',
    prNumber: 1039,
    htmlUrl: 'https://gh/c/bbb2222',
  },
];

describe('escapeSlackText', () => {
  it('escapes Slack-significant characters', () => {
    expect(escapeSlackText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('coerces nullish input to an empty string', () => {
    expect(escapeSlackText(undefined)).toBe('');
    expect(escapeSlackText(null)).toBe('');
  });
});

describe('parseUserMap', () => {
  it('returns the users object', () => {
    expect(parseUserMap('{"users":{"octocat":"U1"}}')).toEqual({ octocat: 'U1' });
  });

  it('degrades to {} on blank, malformed, or shapeless input', () => {
    expect(parseUserMap('')).toEqual({});
    expect(parseUserMap('   ')).toEqual({});
    expect(parseUserMap('not json')).toEqual({});
    expect(parseUserMap('{"users":[]}')).toEqual({});
    expect(parseUserMap('{"nope":true}')).toEqual({});
  });
});

describe('resolveMention', () => {
  it('prefers a mapped Slack id (real ping)', () => {
    expect(resolveMention({ octocat: 'U123' }, 'octocat')).toBe('<@U123>');
  });

  it('falls back to a non-pinging @handle when unmapped', () => {
    expect(resolveMention({}, 'octocat')).toBe('@octocat');
  });

  it('escapes the unmapped handle and handles a missing author', () => {
    expect(resolveMention({}, 'a<b')).toBe('@a&lt;b');
    expect(resolveMention({}, null)).toBe('the author');
    expect(resolveMention({}, '')).toBe('the author');
  });
});

describe('renderSubject', () => {
  it('links the PR when known', () => {
    expect(
      renderSubject({
        pr: { number: 42, title: 'Add thing', url: 'https://gh/pr/42' },
        commitUrl: null,
        shortSha: 'abc1234',
      }),
    ).toBe('<https://gh/pr/42|#42 Add thing>');
  });

  it('falls back to the commit link, then the bare sha', () => {
    expect(
      renderSubject({ pr: null, commitUrl: 'https://gh/c/abc1234', shortSha: 'abc1234' }),
    ).toBe('<https://gh/c/abc1234|abc1234>');
    expect(renderSubject({ pr: null, commitUrl: null, shortSha: 'abc1234' })).toBe(
      '`abc1234`',
    );
  });
});

describe('formatDuration', () => {
  it('renders seconds, minutes, and hours compactly', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(475_000)).toBe('7m 55s');
    expect(formatDuration(420_000)).toBe('7m');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
  });

  it('is empty for nonsense', () => {
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });
});

describe('renderClockTime', () => {
  it('emits a Slack date token so each reader sees their own timezone', () => {
    expect(renderClockTime('2026-08-03T19:43:04Z')).toBe('<!date^1785786184^{time}|19:43 UTC>');
  });

  it('is empty for a missing or unparseable timestamp', () => {
    expect(renderClockTime(null)).toBe('');
    expect(renderClockTime('never')).toBe('');
  });
});

describe('renderPurposeDetail / renderPurposeFields', () => {
  it('shows how long a finished deploy took', () => {
    expect(
      renderPurposeDetail({
        status: 'success',
        startedAt: '2026-08-03T19:35:05Z',
        completedAt: '2026-08-03T19:43:00Z',
      }),
    ).toBe('7m 55s');
  });

  it('dates an awaiting purpose from when its approval was asked for', () => {
    expect(
      renderPurposeDetail({
        status: 'awaiting',
        createdAt: '2026-08-03T19:43:00Z',
        startedAt: '2026-08-03T19:51:19Z',
      }),
    ).toBe('since <!date^1785786180^{time}|19:43 UTC>');
    expect(renderPurposeDetail({ status: 'awaiting', startedAt: '2026-08-03T19:43:04Z' })).toMatch(
      /^since /,
    );
  });

  it('shows since when for in-flight and awaiting states', () => {
    expect(renderPurposeDetail({ status: 'in_progress', startedAt: '2026-08-03T19:43:04Z' })).toBe(
      'since <!date^1785786184^{time}|19:43 UTC>',
    );
    expect(renderPurposeDetail({ status: 'awaiting', startedAt: '2026-08-03T19:43:04Z' })).toMatch(
      /^since /,
    );
  });

  it('shows nothing for states with no honest number', () => {
    expect(renderPurposeDetail({ status: 'pending' })).toBe('');
    expect(renderPurposeDetail({ status: 'blocked', startedAt: '2026-08-03T19:43:04Z' })).toBe('');
    expect(renderPurposeDetail({ status: 'success', startedAt: null, completedAt: null })).toBe('');
    expect(renderPurposeDetail({ status: 'in_progress', startedAt: null })).toBe('');
  });

  it('emits name/status pairs so Slack lays the table out as two columns', () => {
    const fields = renderPurposeFields([
      {
        name: 'stage',
        status: 'success',
        startedAt: '2026-08-03T19:35:05Z',
        completedAt: '2026-08-03T19:43:00Z',
      },
      { name: 'demo', status: 'in_progress', startedAt: '2026-08-03T19:43:04Z' },
      { name: 'prod', status: 'awaiting', createdAt: '2026-08-03T19:43:00Z' },
    ]);
    expect(fields).toHaveLength(6);
    expect(fields[0]).toEqual({ type: 'mrkdwn', text: '*stage*' });
    expect(fields[1].text).toBe(':large_green_circle:  live  ·  _7m 55s_');
    expect(fields[2].text).toBe('*demo*');
    expect(fields[3].text).toBe(
      ':large_yellow_circle:  deploying  ·  _since <!date^1785786184^{time}|19:43 UTC>_',
    );
    expect(fields[5].text).toBe(
      ':large_orange_circle:  awaiting  ·  _since <!date^1785786180^{time}|19:43 UTC>_',
    );
  });

  it('falls back to the pending presentation for an unknown status', () => {
    expect(renderPurposeFields([{ name: 'prod', status: 'weird' }])[1].text).toBe(
      ':white_circle:  queued',
    );
  });

  it('escapes a purpose name and tolerates no purposes', () => {
    expect(renderPurposeFields([{ name: 'a<b', status: 'pending' }])[0].text).toBe('*a&lt;b*');
    expect(renderPurposeFields([])).toEqual([]);
    expect(renderPurposeFields(null)).toEqual([]);
  });

});

describe('renderFooter', () => {
  it('links the run, the compare view, and the commit', () => {
    expect(
      renderFooter({
        runUrl: 'https://gh/run/1',
        compareUrl: 'https://gh/compare',
        commitUrl: 'https://gh/c/abc1234',
        shortSha: 'abc1234',
      }),
    ).toBe(
      '<https://gh/run/1|View pipeline>  ·  <https://gh/compare|Compare>  ·  <https://gh/c/abc1234|abc1234>',
    );
  });

  it('drops the parts it does not have', () => {
    expect(renderFooter({ shortSha: 'abc1234' })).toBe('`abc1234`');
    expect(renderFooter({})).toBe('');
  });

  it('code-formats the sha only when it is not a link label', () => {
    expect(renderFooter({ commitUrl: 'https://gh/c/abc1234', shortSha: 'abc1234' })).toBe(
      '<https://gh/c/abc1234|abc1234>',
    );
  });
});

describe('buildDeployMessage', () => {
  const pr = { number: 7, title: 'Ship it', url: 'https://gh/pr/7' };
  const purposes = [
    { name: 'stage', status: 'success', startedAt: '2026-08-03T19:35:05Z', completedAt: '2026-08-03T19:43:00Z' },
    { name: 'demo', status: 'in_progress', startedAt: '2026-08-03T19:43:04Z' },
    { name: 'prod', status: 'awaiting' },
  ];

  it('breaks the message up: heading, the change, then the purpose grid', () => {
    const { text, blocks } = buildDeployMessage({
      purposes: purposes,
      pr,
      mention: '<@U1>',
      runUrl: 'https://gh/run/1',
      commitUrl: 'https://gh/c/abc1234',
      shortSha: 'abc1234',
    });

    expect(blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: ':large_yellow_circle: Deploying to demo', emoji: true },
    });
    expect(blocks[1].text.text).toBe('*<https://gh/pr/7|#7 Ship it>*\n<@U1>');
    expect(blocks[2]).toEqual({ type: 'divider' });
    expect(blocks[3].fields.map((f) => f.text)).toEqual([
      '*stage*',
      ':large_green_circle:  live  ·  _7m 55s_',
      '*demo*',
      ':large_yellow_circle:  deploying  ·  _since <!date^1785786184^{time}|19:43 UTC>_',
      '*prod*',
      ':large_orange_circle:  awaiting',
    ]);
    const footer = blocks[blocks.length - 1];
    expect(footer.type).toBe('context');
    expect(footer.elements[0].text).toContain('<https://gh/run/1|View pipeline>');
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(text).toBe(
      'Deploying to demo — #7 Ship it (stage: live · demo: deploying · prod: awaiting approval)',
    );
  });

  it('keeps purpose rows ordered across sections when there are more than five purposes', () => {
    const names = ['dev', 'qa', 'stage', 'demo', 'canary', 'prod'];
    const { blocks } = buildDeployMessage({
      purposes: names.map((name) => ({ name, status: 'pending' })),
      pr,
      mention: '@octocat',
    });
    const sections = blocks.filter((block) => block.fields);
    expect(sections.map((block) => block.fields.length)).toEqual([10, 2]);
    const rowLabels = sections.flatMap((block) => block.fields.filter((_, index) => index % 2 === 0));
    expect(rowLabels.map((field) => field.text)).toEqual(names.map((name) => `*${name}*`));
  });

  it.each(['dev', 'stage', 'demo', 'prod', 'release'])('names the repository when it is live in %s', (name) => {
    const { text, blocks } = buildDeployMessage({
      purposes: [{ name, status: 'success' }],
      repository: 'Arda-cards/arda-frontend-app',
      pr,
      mention: '@octocat',
    });
    const headline = `arda-frontend-app live in ${name}`;
    expect(blocks[0].text.text).toBe(`:white_check_mark: ${headline}`);
    expect(text).toContain(`${headline} —`);
  });

  it('keeps long repository and purpose names within the Slack header limit', () => {
    const repository = 'a'.repeat(100);
    const purpose = 'b'.repeat(100);
    const { text, blocks } = buildDeployMessage({
      purposes: [{ name: purpose, status: 'in_progress' }],
      repository,
      pr,
      mention: '@octocat',
    });
    expect(blocks[0].text.text).toHaveLength(150);
    expect(text).toContain(`${repository} deploying to ${purpose}`);
  });

  it.each([
    [' v1.2.3 ', 'arda-frontend-app v1.2.3 live in release'],
    ['', 'arda-frontend-app live in release'],
  ])('formats the deployment title with version %j', (version, headline) => {
    const { text, blocks } = buildDeployMessage({
      purposes: [{ name: 'release', status: 'success' }],
      repository: 'Arda-cards/arda-frontend-app',
      version,
      pr,
      mention: '@octocat',
    });
    expect(blocks[0].text.text).toBe(`:white_check_mark: ${headline}`);
    expect(text).toContain(`${headline} —`);
  });

  it('headlines "Deployed" with a check when every purpose is live', () => {
    const { blocks } = buildDeployMessage({
      purposes: [
        { name: 'stage', status: 'success' },
        { name: 'demo', status: 'success' },
        { name: 'prod', status: 'success' },
      ],
      pr,
      mention: '@octocat',
      runUrl: 'https://gh/run/1',
    });
    expect(blocks[0].text.text).toBe(':white_check_mark: Live in prod');
  });

  it('headlines "Deploy incomplete" and omits the footer when there are no links', () => {
    const { blocks } = buildDeployMessage({
      purposes: [
        { name: 'stage', status: 'success' },
        { name: 'demo', status: 'success' },
        { name: 'prod', status: 'blocked' },
      ],
      pr,
      mention: '@octocat',
    });
    expect(blocks[0].text.text).toBe(':no_entry: Stopped at prod');
    expect(blocks.some((b) => b.type === 'context')).toBe(false);
  });

  it('escapes markup in the PR title and falls back to the sha with no PR', () => {
    const { blocks } = buildDeployMessage({
      purposes: purposes,
      pr: null,
      mention: '@a&b',
      commitUrl: 'https://gh/c/abc1234',
      shortSha: 'abc1234',
    });
    expect(blocks[1].text.text).toContain('<https://gh/c/abc1234|abc1234>');

    const { blocks: escaped } = buildDeployMessage({
      purposes: purposes,
      pr: { number: 9, title: 'Fix <script> & things', url: 'https://gh/pr/9' },
      mention: '@octocat',
    });
    expect(escaped[1].text.text).toContain('Fix &lt;script&gt; &amp; things');
  });

  it('replaces the single-change block with a grouped list when it carries a range', () => {
    const { text, blocks } = buildDeployMessage({
      purposes: purposes,
      pr,
      mention: '<@U1>',
      runUrl: 'https://gh/run/1',
      changes: sampleChanges,
      userMap: { alice: 'U1' },
      repoUrl: 'https://gh/org/repo',
      compareUrl: 'https://gh/compare',
    });
    expect(blocks[1]).toEqual({ type: 'divider' });
    expect(blocks[2].fields).toBeDefined();
    const list = blocks.find((b) => b.text?.text?.startsWith('2 commits from'));
    expect(list.text.text).toContain('<@U1> — 1');
    expect(list.text.text).toContain('#1042 Fix scan URL prompt');
    expect(list.text.text).toContain('@bob — 1');
    expect(text).toContain('2 commits from 2 authors');
  });

  it('never puts mrkdwn inside a link label — Slack renders it literally', () => {
    const { blocks } = buildDeployMessage({
      purposes: purposes,
      pr: null,
      mention: '@octocat',
      runUrl: 'https://gh/run/1',
      commitUrl: 'https://gh/c/abc1234',
      shortSha: 'abc1234',
      changes: sampleChanges,
      repoUrl: 'https://gh/org/repo',
      compareUrl: 'https://gh/compare',
      maxChanges: 1,
    });
    const rendered = blocks
      .map((block) => {
        if (block.type === 'context') return block.elements[0].text;
        if (block.fields) return block.fields.map((field) => field.text).join('\n');
        return block.text?.text ?? '';
      })
      .join('\n');
    const labels = [...rendered.matchAll(/<[^|>]+\|([^>]*)>/g)].map(([, label]) => label);
    expect(labels.length).toBeGreaterThan(3);
    for (const label of labels) expect(label).not.toMatch(/[`*_]/);
  });

  it('keeps the single-PR header (no list) when a deploy carries just one change', () => {
    const { blocks } = buildDeployMessage({
      purposes: purposes,
      pr,
      mention: '<@U1>',
      changes: [sampleChanges[0]],
    });
    expect(blocks[1].text.text).toBe('*<https://gh/pr/7|#7 Ship it>*\n<@U1>');
    expect(blocks.some((b) => b.text?.text?.startsWith('*Going out:*'))).toBe(
      false,
    );
  });
});

describe('buildProdAnnouncement', () => {
  it('names a custom final purpose in the announcement', () => {
    const { text, blocks } = buildProdAnnouncement({
      pr: null,
      mention: 'the author',
      repository: 'Arda-cards/arda-frontend-app',
      version: 'v1.2.3',
      finalPurpose: 'release',
    });
    expect(text).toBe('arda-frontend-app v1.2.3 shipped to release — this commit');
    expect(blocks[0].text.text).toBe(':rocket: arda-frontend-app v1.2.3 shipped to release');
  });

  it('is a single "Shipped to production" line plus the link footer', () => {
    const { text, blocks } = buildProdAnnouncement({
      pr: { number: 7, title: 'Ship it', url: 'https://gh/pr/7' },
      mention: '<@U1>',
      runUrl: 'https://gh/run/1',
    });
    expect(blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: ':rocket: Shipped to production', emoji: true },
    });
    expect(blocks[1].text.text).toBe('*<https://gh/pr/7|#7 Ship it>*\n<@U1>');
    const footer = blocks[blocks.length - 1];
    expect(footer.type).toBe('context');
    expect(footer.elements[0].text).toBe('<https://gh/run/1|View pipeline>');
    expect(text).toBe('Shipped to production — #7 Ship it');
  });

  it('omits the footer when there is nothing to link', () => {
    const { blocks } = buildProdAnnouncement({ pr: null, mention: 'the author' });
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text.text).toContain('the author');
  });

  it('lists a range the same way the daily digest does', () => {
    const { text, blocks } = buildProdAnnouncement({
      mention: '@octocat',
      changes: sampleChanges,
      userMap: { alice: 'U1' },
      repoUrl: 'https://gh/org/repo',
      runUrl: 'https://gh/run/1',
    });
    expect(blocks[0].text.text).toBe(':rocket: Shipped to production');
    expect(blocks[1].text.text).toBe(
      [
        '2 commits from 2 authors',
        '',
        '<@U1> — 1',
        '    • <https://gh/org/repo/pull/1042|#1042 Fix scan URL prompt>',
        '',
        '@bob — 1',
        '    • <https://gh/org/repo/pull/1039|#1039 Order queue tooltip>',
      ].join('\n'),
    );
    expect(text).toBe('Shipped to production — 2 commits from 2 authors');
  });
});

describe('renderChangeCount / renderChangeList', () => {
  it('sizes a range on its own line, singular when it is one of each', () => {
    expect(renderChangeCount(20, 6)).toBe('20 commits from 6 authors');
    expect(renderChangeCount(1, 1)).toBe('1 commit from 1 author');
  });

  it('returns null when there are no changes', () => {
    expect(renderChangeList({ changes: [] })).toBeNull();
    expect(renderChangeList({ changes: undefined })).toBeNull();
  });

  it('groups by author, busiest first, naming each person exactly once', () => {
    const text = renderChangeList({
      changes: sampleChanges,
      userMap: { alice: 'U1' },
      repoUrl: 'https://gh/org/repo',
    });
    expect(text).toBe(
      [
        '2 commits from 2 authors',
        '',
        '<@U1> — 1',
        '    • <https://gh/org/repo/pull/1042|#1042 Fix scan URL prompt>',
        '',
        '@bob — 1',
        '    • <https://gh/org/repo/pull/1039|#1039 Order queue tooltip>',
      ].join('\n'),
    );
    expect(text).not.toContain('cc ');
  });

  it('caps each author and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      login: 'solo',
      subject: `fix: thing ${i} (#${i})`,
      prNumber: i,
      shortSha: `sha${i}`,
      htmlUrl: `https://gh/c/${i}`,
    }));
    const text = renderChangeList({ changes: many, repoUrl: 'https://gh/org/repo', maxPerAuthor: 5 });
    expect(text).toContain('7 commits from 1 author');
    expect(text).toContain('@solo — 7');
    expect(text).toContain('    _+2 more_');
  });
});
