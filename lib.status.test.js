const {
  parseTrackedPurposes,
  normalizePurposeStatus,
  isTerminalStatus,
  resolvePurposeStatuses,
  indexPurposeJobs,
  currentStatusHeadline,
} = require('./lib');

describe('parseTrackedPurposes', () => {
  it('uses the default pipeline when the input is omitted or blank', () => {
    expect(parseTrackedPurposes()).toEqual(['dev', 'stage', 'demo', 'prod']);
    expect(parseTrackedPurposes(' , ')).toEqual(['dev', 'stage', 'demo', 'prod']);
  });

  it('preserves the requested order while normalizing names and removing duplicates', () => {
    expect(parseTrackedPurposes(' Preview-EU, QA, , preview-eu ')).toEqual(['preview-eu', 'qa']);
  });
});

describe('normalizePurposeStatus / isTerminalStatus', () => {
  it('maps raw GitHub job results to the status vocabulary', () => {
    expect(normalizePurposeStatus('success')).toBe('success');
    expect(normalizePurposeStatus('failure')).toBe('failure');
    expect(normalizePurposeStatus('cancelled')).toBe('cancelled');
    expect(normalizePurposeStatus('in_progress')).toBe('in_progress');
    expect(normalizePurposeStatus('awaiting')).toBe('awaiting');
  });

  it('reads a skipped deploy job as blocked (its dependency failed)', () => {
    expect(normalizePurposeStatus('skipped')).toBe('blocked');
    expect(normalizePurposeStatus('blocked')).toBe('blocked');
  });

  it('treats "", unknown, and nullish as pending', () => {
    expect(normalizePurposeStatus('')).toBe('pending');
    expect(normalizePurposeStatus('   ')).toBe('pending');
    expect(normalizePurposeStatus('weird')).toBe('pending');
    expect(normalizePurposeStatus(undefined)).toBe('pending');
    expect(normalizePurposeStatus(null)).toBe('pending');
  });

  it('treats only settled statuses as terminal', () => {
    expect(['success', 'failure', 'blocked', 'cancelled'].every(isTerminalStatus)).toBe(true);
    expect(['pending', 'awaiting', 'in_progress'].some(isTerminalStatus)).toBe(false);
  });
});

describe('indexPurposeJobs', () => {
  it('keys deploy jobs by purpose, ignoring everything else', () => {
    const index = indexPurposeJobs([
      { name: 'deploy (dev) / Deploy to dev', status: 'completed', conclusion: 'success' },
      {
        name: 'deploy (stage) / Deploy to stage',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-08-03T19:21:49Z',
        startedAt: '2026-08-03T19:35:05Z',
        completedAt: '2026-08-03T19:43:00Z',
      },
      { name: 'Deploy (DEMO)', status: 'in_progress', conclusion: null },
      { name: 'deploy (prod) checks', status: 'in_progress' },
      { name: 'quality-gate-evaluate', status: 'completed', conclusion: 'success' },
      { name: 'notify-stage', status: 'in_progress', conclusion: null },
    ]);
    expect(Object.keys(index).sort()).toEqual(['demo', 'dev', 'stage']);
    expect(index.stage).toEqual({
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-08-03T19:21:49Z',
      startedAt: '2026-08-03T19:35:05Z',
      completedAt: '2026-08-03T19:43:00Z',
    });
    expect(index.demo.status).toBe('in_progress');
  });

  it('keeps the first job per purpose and tolerates junk', () => {
    const index = indexPurposeJobs([
      { name: 'deploy (prod) / Deploy to prod', status: 'in_progress' },
      { name: 'deploy (prod) / Deploy to prod', status: 'queued' },
      { name: '' },
      {},
    ]);
    expect(index.prod.status).toBe('in_progress');
    expect(indexPurposeJobs(null)).toEqual({});
  });

  it('substitutes every placeholder literally in a custom pattern', () => {
    const index = indexPurposeJobs([
      { name: 'promote qa.eu [qa.eu] / Apply', status: 'in_progress' },
      { name: 'promote prod [prod]', status: 'completed' },
    ], ['qa.eu', 'prod'], 'Promote $purpose [$purpose]');
    expect(index['qa.eu'].status).toBe('in_progress');
    expect(index.prod.status).toBe('completed');
  });
});

describe('resolvePurposeStatuses', () => {
  const hints = { stage: 'success', demo: 'pending', prod: 'pending' };

  it('trusts a terminal workflow hint over the live run', () => {
    const [, stage] = resolvePurposeStatuses({
      hints,
      jobs: { stage: { status: 'in_progress' } },
    });
    expect(stage).toMatchObject({ name: 'stage', status: 'success' });
  });

  it('reads "deploying" off a running job the workflow still calls queued', () => {
    const [, , demo] = resolvePurposeStatuses({
      hints,
      jobs: { demo: { status: 'in_progress', startedAt: '2026-08-03T19:43:04Z' } },
    });
    expect(demo).toMatchObject({ status: 'in_progress', source: 'job', startedAt: '2026-08-03T19:43:04Z' });
  });

  it('reads a completed job the workflow has not reported yet', () => {
    const [, , demo] = resolvePurposeStatuses({
      hints,
      jobs: { demo: { status: 'completed', conclusion: 'failure' } },
    });
    expect(demo).toMatchObject({ status: 'failure', source: 'job' });
  });

  it('surfaces a purpose parked on a required approval', () => {
    const [, , , prod] = resolvePurposeStatuses({ hints, awaiting: ['prod'] });
    expect(prod).toMatchObject({ status: 'awaiting', source: 'approval' });
  });

  it('prefers "awaiting approval" over the workflow claiming it is starting', () => {
    const [stage] = resolvePurposeStatuses({
      hints: { stage: 'in_progress' },
      names: ['stage'],
      awaiting: ['stage'],
    });
    expect(stage.status).toBe('awaiting');
  });

  it('falls back to the hint, flagged as unconfirmed, when the run knows nothing', () => {
    const [stage] = resolvePurposeStatuses({ hints: { stage: 'in_progress' }, names: ['stage'] });
    expect(stage).toMatchObject({ status: 'in_progress', source: 'hint' });
  });

  it('defaults to all-pending with no inputs at all', () => {
    expect(resolvePurposeStatuses().map((purpose) => [purpose.name, purpose.status])).toEqual([
      ['dev', 'pending'],
      ['stage', 'pending'],
      ['demo', 'pending'],
      ['prod', 'pending'],
    ]);
  });

  it('resolves only the configured purposes in their supplied order', () => {
    const names = ['preview-eu', 'qa'];
    const jobs = indexPurposeJobs([
      { name: 'deploy-prod', status: 'completed', conclusion: 'failure' },
      { name: 'deploy-QA / Deploy to QA', status: 'in_progress' },
    ], names, 'deploy-$purpose');
    expect(Object.keys(jobs)).toEqual(['qa']);
    const purposes = resolvePurposeStatuses({ names, jobs, awaiting: ['preview-eu'] });
    expect(purposes.map(({ name, status }) => [name, status])).toEqual([
      ['preview-eu', 'awaiting'],
      ['qa', 'in_progress'],
    ]);
  });
});

describe('currentStatusHeadline', () => {
  const purposes = (...statuses) =>
    ['stage', 'demo', 'prod'].map((name, i) => ({ name, status: statuses[i] }));

  it('names the last purpose when the pipeline succeeds', () => {
    const purposes = [
      { name: 'prod', status: 'success' },
      { name: 'release', status: 'success' },
    ];
    expect(currentStatusHeadline(purposes).text).toBe('Live in release');
  });

  it('names the purpose currently going out', () => {
    expect(currentStatusHeadline(purposes('success', 'in_progress', 'pending'))).toEqual({
      emoji: ':large_yellow_circle:',
      text: 'Deploying to demo',
    });
  });

  it('names the purpose a reviewer is sitting on', () => {
    expect(currentStatusHeadline(purposes('success', 'success', 'awaiting'))).toEqual({
      emoji: ':large_orange_circle:',
      text: 'Approval needed: prod',
    });
  });

  it('leads with bad news over anything still moving', () => {
    expect(currentStatusHeadline(purposes('success', 'failure', 'in_progress')).text).toBe(
      'Failed at demo',
    );
    expect(currentStatusHeadline(purposes('success', 'blocked', 'blocked')).text).toBe(
      'Stopped at demo',
    );
    expect(currentStatusHeadline(purposes('cancelled', 'pending', 'pending')).text).toBe(
      'Stopped at stage',
    );
  });

  it('is done only when every purpose is live', () => {
    expect(currentStatusHeadline(purposes('success', 'success', 'success'))).toEqual({
      emoji: ':white_check_mark:',
      text: 'Live in prod',
    });
  });

  it('falls back to queued when nothing has started', () => {
    expect(currentStatusHeadline(purposes('pending', 'pending', 'pending')).text).toBe('Queued');
    expect(currentStatusHeadline([]).text).toBe('Queued');
  });
});
