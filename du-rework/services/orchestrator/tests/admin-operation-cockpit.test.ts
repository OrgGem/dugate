import { fetchOperationDetail } from '../src/app/admin/operation-section-data';
import type { OperationDetailCatalogEntry } from '../src/app/admin/operation-section-data';
import { renderOperationSection } from '../src/app/admin/operation-section-renderer';

type CockpitState = 'RUNNING' | 'WAITING_INPUT' | 'FAILED' | 'SUCCEEDED';

const RAW_PROVIDER_DIAGNOSTIC = 'RAW_PROVIDER_STACK_SECRET_MARKER';

function catalogEntry(state: CockpitState): OperationDetailCatalogEntry {
  const operation = {
    id: 'op-cockpit-1',
    tenantId: 'tenant-cockpit',
    businessId: 'review',
    businessVersion: 'v3',
    action: 'ingest',
    state,
    stateVersion: 7,
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:05:00.000Z',
    deadlineAt: '2026-09-25T10:00:00.000Z',
    replayOf: null,
    progress: { percent: 45, message: 'Parsing document' },
    links: {
      self: '/api/v1/operations/op-cockpit-1',
      result: '/api/v1/operations/op-cockpit-1/result',
    },
    wait: null,
    error: null,
  } as const;

  if (state === 'WAITING_INPUT') {
    return {
      operation: {
        ...operation,
        wait: {
          waitId: 'wait-cockpit-1',
          inputSchema: {
            type: 'object',
            properties: { notes: { type: 'string', widget: 'textarea' } },
            required: ['notes'],
          },
          expiresAt: '2099-09-25T10:00:00.000Z',
        },
      },
      result: null,
      artifacts: [],
    };
  }

  if (state === 'FAILED') {
    return {
      operation: {
        ...operation,
        error: {
          code: 'PROVIDER_FAILURE',
          title: 'The document provider could not complete the request.',
          detail: RAW_PROVIDER_DIAGNOSTIC,
        },
      },
      result: null,
      artifacts: [],
    };
  }

  return {
    operation,
    result: state === 'SUCCEEDED'
      ? { schemaVersion: '1', data: { accepted: true }, warnings: [] }
      : null,
    artifacts: state === 'SUCCEEDED'
      ? [{
          artifactId: 'artifact-cockpit-1',
          role: 'output',
          fileName: 'result.md',
          mimeType: 'text/markdown',
          sizeBytes: 128,
          download: '/admin/artifacts/artifact-cockpit-1',
        }]
      : [],
  };
}

async function renderCockpit(state: CockpitState): Promise<string> {
  const fetch = await fetchOperationDetail({
    operationId: 'op-cockpit-1',
    jsonBaseUrl: '',
    adminToken: '',
    manifestCatalog: {
      entries: [catalogEntry(state)],
      serverNow: '2026-09-24T10:05:00.000Z',
    },
  });
  if (fetch.kind !== 'ok') throw new Error(`Expected operation detail, got ${fetch.kind}`);
  return renderOperationSection({ fetch }).html;
}

describe('admin operations cockpit renderer', () => {
  it('puts current state and permitted actions in the detail header', async () => {
    const html = await renderCockpit('RUNNING');
    const statusIndex = html.indexOf('aria-label="Current operation status"');
    const actionIndex = html.indexOf('data-confirmation-trigger="operation-cancel-confirmation"');
    const metadataIndex = html.indexOf('class="operation-section__meta"');

    expect(statusIndex).toBeGreaterThan(-1);
    expect(actionIndex).toBeGreaterThan(statusIndex);
    expect(metadataIndex).toBeGreaterThan(actionIndex);
    expect(html).toContain('data-state-badge="info"');
    expect(html).toContain('data-can-cancel="true"');
    expect(html).toContain('data-can-replay="false"');
  });

  it('provides accessible modal confirmation triggers for cancel and replay', async () => {
    const html = await renderCockpit('FAILED');

    expect(html).toContain('data-confirmation-trigger="operation-cancel-confirmation"');
    expect(html).toContain('command="show-modal" commandfor="operation-cancel-confirmation"');
    expect(html).toContain('aria-haspopup="dialog" aria-controls="operation-cancel-confirmation"');
    expect(html).toContain('<dialog class="operation-section__confirmation" id="operation-cancel-confirmation"');
    expect(html).toContain('id="operation-cancel-form"');
    expect(html).toContain('data-action="cancel-operation"');

    expect(html).toContain('data-confirmation-trigger="operation-replay-confirmation"');
    expect(html).toContain('command="show-modal" commandfor="operation-replay-confirmation"');
    expect(html).toContain('<dialog class="operation-section__confirmation" id="operation-replay-confirmation"');
    expect(html).toContain('data-action="replay-operation"');
  });

  it('confirms resume through the wait form while preserving its CAS token', async () => {
    const html = await renderCockpit('WAITING_INPUT');

    expect(html).toContain('data-confirmation-trigger="operation-resume-confirmation"');
    expect(html).toContain('command="show-modal" commandfor="operation-resume-confirmation"');
    expect(html).toContain('<dialog class="operation-section__confirmation" id="operation-resume-confirmation"');
    expect(html).toContain('id="operation-wait-form"');
    expect(html).toContain('name="casToken" value="wait-cockpit-1"');
    expect(html).toContain('type="submit" form="operation-wait-form"');
    expect(html).toContain('data-action="submit-resume"');
  });

  it('groups progress, artifacts, and errors in accordions and omits raw diagnostics', async () => {
    const failed = await renderCockpit('FAILED');
    expect(failed).toContain('<details class="operation-section__checkpoints" data-checkpoint-source="operation-progress"');
    expect(failed).toContain('<summary>Latest progress checkpoint</summary>');
    expect(failed).toContain('<details class="operation-section__error" data-operation-error="true">');
    expect(failed).toContain('<summary>Error details</summary>');
    expect(failed).toContain('Diagnostic details are hidden in this view.');
    expect(failed).not.toContain(RAW_PROVIDER_DIAGNOSTIC);

    const succeeded = await renderCockpit('SUCCEEDED');
    expect(succeeded).toContain('<details class="operation-section__artifacts" data-artifact-total="1">');
    expect(succeeded).toContain('<summary>Artifacts (1)</summary>');
    expect(succeeded).toContain('result.md');
  });
});
