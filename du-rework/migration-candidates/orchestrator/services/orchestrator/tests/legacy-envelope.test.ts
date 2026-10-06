import { toLegacyEnvelope, toLegacyListItem, toLegacyListPage, type LegacyOperationRow } from '../src/compat/legacy-envelope';

interface GoldenCase {
  input: LegacyOperationRow;
  expected: Record<string, unknown>;
}

/**
 * Golden parity against the legacy formatter.
 *
 * `fixtures/legacy-envelope-golden.json` was produced by executing a
 * transcription of `formatOperationResponse` from the legacy repo's
 * `lib/pipelines/format.ts:17-73` over one operation per lifecycle state.
 * Comparing against it means a change in key order, a missing null, a
 * default of 0 where legacy emitted null, or an extra `result` block all fail
 * here instead of reaching a legacy client.
 */
const golden = JSON.parse(
  require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'fixtures', 'legacy-envelope-golden.json'),
    'utf8',
  ),
) as Record<string, GoldenCase>;

describe('legacy envelope — golden parity with formatOperationResponse', () => {
  it.each(Object.keys(golden))('%s', (name) => {
    const { input, expected } = golden[name]!;
    expect(toLegacyEnvelope(input)).toEqual(expected);
  });
});

describe('legacy envelope — the quirks a client can depend on', () => {
  it('CANCELLED is done:true with neither result nor error', () => {
    const body = toLegacyEnvelope({ id: 'op-1', done: true, state: 'CANCELLED' });
    expect(body.done).toBe(true);
    expect(body).not.toHaveProperty('result');
    expect(body).not.toHaveProperty('error');
  });

  it('TIMED_OUT is done:true with neither result nor error', () => {
    const body = toLegacyEnvelope({ id: 'op-1', done: true, state: 'TIMED_OUT' });
    expect(body.done).toBe(true);
    expect(body).not.toHaveProperty('result');
    expect(body).not.toHaveProperty('error');
  });

  it('passes the state through verbatim — no vocabulary flattening', () => {
    // legacy-operation-serializers.ts maps CANCELLED to FAILED. That is a
    // deliberate divergence for the canonical surface and would be a wire
    // change here, so it is pinned against.
    expect((toLegacyEnvelope({ id: 'op-1', done: true, state: 'CANCELLED' })
      .metadata as { state: string }).state).toBe('CANCELLED');
    expect((toLegacyEnvelope({ id: 'op-1', done: true, state: 'TIMED_OUT' })
      .metadata as { state: string }).state).toBe('TIMED_OUT');
  });

  it('never adds a canonical_state key the legacy body did not have', () => {
    const body = toLegacyEnvelope({ id: 'op-1', done: false, state: 'RUNNING' });
    expect(Object.keys(body.metadata as object).sort()).toEqual([
      'create_time', 'current_step', 'pipeline', 'pipeline_steps',
      'progress_message', 'progress_percent', 'state', 'update_time',
    ].sort());
  });

  it('keeps result on FAILED only when stepsResultJson was set', () => {
    const withSteps = toLegacyEnvelope({
      id: 'op-1', done: true, state: 'FAILED',
      stepsResultJson: '[{"step":1}]', errorCode: 'E', errorMessage: 'm',
    });
    expect(withSteps).toHaveProperty('result');

    const without = toLegacyEnvelope({
      id: 'op-1', done: true, state: 'FAILED',
      stepsResultJson: null, errorCode: 'E', errorMessage: 'm',
    });
    expect(without).not.toHaveProperty('result');
    expect(without).toHaveProperty('error');
  });

  it('omits pages_processed and model_used from the FAILED usage block', () => {
    const body = toLegacyEnvelope({
      id: 'op-1', done: true, state: 'FAILED',
      stepsResultJson: '[{"step":1}]', errorCode: 'E', errorMessage: 'm',
      totalInputTokens: 7, totalOutputTokens: 8, pagesProcessed: 9, modelUsed: 'm',
      totalCostUsd: 0.25,
    });
    const usage = (body.result as { usage: Record<string, unknown> }).usage;
    expect(Object.keys(usage).sort()).toEqual(
      ['breakdown', 'cost_usd', 'input_tokens', 'output_tokens'].sort(),
    );
  });

  it('keeps every metadata key present even when the column is null', () => {
    const body = toLegacyEnvelope({ id: 'op-1', done: false, state: 'RUNNING' });
    const meta = body.metadata as Record<string, unknown>;
    for (const key of ['current_step', 'progress_percent', 'progress_message']) {
      expect(meta).toHaveProperty(key);
      expect(meta[key]).toBeNull();
    }
  });

  it('points download_url at the legacy operation path, not /artifacts', () => {
    const body = toLegacyEnvelope({
      id: 'abc', done: true, state: 'SUCCEEDED', outputFormat: 'md',
    });
    expect((body.result as { download_url: string }).download_url)
      .toBe('/api/v1/operations/abc/download');
  });

  it('degrades a corrupt pipelineJson to an empty list instead of throwing', () => {
    const body = toLegacyEnvelope({
      id: 'op-1', done: false, state: 'RUNNING', pipelineJson: '{not json',
    });
    expect((body.metadata as { pipeline: string[] }).pipeline).toEqual([]);
  });

  it('drops a pipeline step that has no processor name', () => {
    const body = toLegacyEnvelope({
      id: 'op-1', done: false, state: 'RUNNING',
      pipelineJson: '[{"processor":"a"},{"nope":1},null]',
    });
    expect((body.metadata as { pipeline: string[] }).pipeline).toEqual(['a']);
  });
});

describe('legacy list projection', () => {
  it('is lighter than the full envelope', () => {
    const item = toLegacyListItem({
      id: 'op-1', done: true, state: 'SUCCEEDED', endpointSlug: 'extract:invoice',
      pipelineJson: '[{"processor":"a"}]', stepsResultJson: '[{"step":1}]',
      totalInputTokens: 5, totalOutputTokens: 6, totalCostUsd: 0.5,
      outputContent: 'should not appear',
    });
    expect(item).not.toHaveProperty('result.content');
    expect((item.metadata as Record<string, unknown>).endpoint_slug).toBe('extract:invoice');
    expect(item.metadata).not.toHaveProperty('pipeline');
    expect(item.metadata).not.toHaveProperty('pipeline_steps');
  });

  it('carries only three usage counters in the list result', () => {
    const item = toLegacyListItem({
      id: 'op-1', done: true, state: 'SUCCEEDED',
      totalInputTokens: 5, totalOutputTokens: 6, pagesProcessed: 9, totalCostUsd: 0.5,
    });
    const usage = (item.result as { usage: Record<string, unknown> }).usage;
    expect(Object.keys(usage).sort()).toEqual(
      ['cost_usd', 'input_tokens', 'output_tokens'].sort(),
    );
  });

  it('mints next_page_token as the plain last-row id', () => {
    const page = toLegacyListPage([
      { id: 'row-1', done: false, state: 'RUNNING' },
      { id: 'row-2', done: false, state: 'RUNNING' },
    ], true);
    // The legacy route reads this back with eq(operations.id, pageToken), so
    // a base64 dialect token would match no row and reset paging to page 1.
    expect(page.next_page_token).toBe('row-2');
  });

  it('returns null on the final page so a client stops', () => {
    const page = toLegacyListPage([{ id: 'row-1', done: true, state: 'SUCCEEDED' }], false);
    expect(page.next_page_token).toBeNull();
    expect(page.operations).toHaveLength(1);
  });
});
