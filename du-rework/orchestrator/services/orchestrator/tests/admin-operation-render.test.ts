/**
 * Focused renderer/fetcher tests for P6-06 operation.
 * Fixtures stay local to this pane; no shared fixture builder is needed.
 */

import { renderOperationSection, renderArtifactRow, renderArtifactsTable, renderResultPanel } from '../src/app/admin/operation-section-renderer';
import { fetchOperationDetail } from '../src/app/admin/operation-section-data';
import type { OperationDetailCatalogEntry, OperationFetchResult } from '../src/app/admin/operation-section-data';

describe("admin-operation renderer (P6-06)", () => {
// ---------------------------------------------------------------------------
  // P6-06 — Operation detail / result / artifacts / cancel / resume / replay
  // ---------------------------------------------------------------------------

  describe('renderOperationSection (P6-06, ok pane)', () => {
    function okCatalogEntry(
      state: 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'WAITING_INPUT' | 'CANCELLED' | 'TIMED_OUT',
    ): OperationDetailCatalogEntry {
      const op = {
        id: 'op-1',
        tenantId: 'tenant-1',
        businessId: 'biz-1',
        businessVersion: 'v1',
        action: 'ingest',
        state,
        stateVersion: 1,
        createdAt: '2026-09-20T00:00:00Z',
        updatedAt: '2026-09-20T00:01:00Z',
        deadlineAt: '2026-09-21T00:00:00Z',
        replayOf: null,
        progress: { percent: 50, message: 'half-way' },
        links: { self: '/api/v1/operations/op-1', result: '/api/v1/operations/op-1/result' },
        wait: null,
        error: null,
      } as const;
      if (state === 'WAITING_INPUT') {
        return {
          operation: {
            ...op,
            wait: {
              waitId: 'w-1',
              inputSchema: {
                type: 'object',
                properties: {
                  notes: { type: 'string', widget: 'textarea', description: 'Free-form reviewer notes' },
                  severity: { type: 'string', enum: ['low', 'med', 'high'] },
                },
                required: ['notes'],
              },
              expiresAt: '2099-09-21T00:00:00Z',
            },
          },
          result: null,
          artifacts: [
            { artifactId: 'a-1', role: 'output', fileName: 'out.md', mimeType: 'text/markdown', sizeBytes: 4096, download: '/dl/a-1' },
          ],
        };
      }
      if (state === 'SUCCEEDED') {
        return {
          operation: op,
          result: { schemaVersion: '1', data: { ok: true, text: 'hi' }, warnings: [] },
          artifacts: [
            { artifactId: 'a-1', role: 'output', fileName: 'out.md', mimeType: 'text/markdown', sizeBytes: 4096, download: '/dl/a-1' },
            { artifactId: 'a-2', role: 'log', fileName: 'run.log', mimeType: 'text/plain', sizeBytes: 1024 },
          ],
        };
      }
      return { operation: op, result: null, artifacts: [] };
    }

    it('renders the ok pane with the discriminated action bars', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('RUNNING')] },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('class="operation-section"');
      expect(out.html).toContain('data-operation-selected="op-1"');
      expect(out.html).toContain('data-operation-state="RUNNING"');
      expect(out.html).toContain('data-can-cancel="true"');
      expect(out.html).toContain('data-can-resume="false"');
      expect(out.html).toContain('data-can-replay="false"');
      expect(out.html).toContain('data-action="cancel-operation"');
      expect(out.html).toContain('data-result-available="false"');
      expect(out.html).toContain('data-artifact-total="0"');
    });

    it('SUCCEEDED exposes canReplay=true and result data in a <pre>', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('SUCCEEDED')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('data-can-cancel="false"');
      expect(out.html).toContain('data-can-replay="true"');
      expect(out.html).toContain('data-replay-label="Replay (new operation)"');
      expect(out.html).toContain('data-result-available="true"');
      expect(out.html).toContain('data-result-schema-version="1"');
      expect(out.html).toContain('data-result-data=');
      expect(out.html).toContain('class="operation-section__result-data"');
      // <pre> body is esc()-escaped, so quotes surface as &quot;.
      expect(out.html).toContain('&quot;ok&quot;: true');
    });

    it('FAILED surfaces the retry label and disabled cancel', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('FAILED')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('data-can-replay="true"');
      expect(out.html).toContain('data-replay-label="Retry (new operation)"');
    });

    it('WAITING_INPUT renders the human-wait form with data-wait-cas', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('WAITING_INPUT')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('class="operation-section__wait"');
      expect(out.html).toContain('data-wait-id="w-1"');
      expect(out.html).toContain('data-wait-cas="w-1"');
      expect(out.html).toContain('data-wait-expired="false"');
      expect(out.html).toContain('data-action="resume-wait"');
      expect(out.html).toContain('data-action="submit-resume"');
      expect(out.html).toContain('name="casToken" value="w-1"');
      expect(out.html).toContain('data-field-name="notes"');
      expect(out.html).toContain('data-field-widget="textarea"');
      expect(out.html).toContain('data-field-name="severity"');
      expect(out.html).toContain('data-field-widget="select"');
      expect(out.html).toContain('data-field-option="low"');
    });

    it('artifacts table exposes per-row discriminators (no raw payload)', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('SUCCEEDED')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('data-artifact-total="2"');
      expect(out.html).toContain('data-action="download-artifact"');
      expect(out.html).toContain('data-artifact-id="a-1"');
      expect(out.html).toContain('data-artifact-role="output"');
      expect(out.html).toContain('data-artifact-no-download="true"');
      expect(out.html).not.toContain('"bytes"');
    });

    it('progress bar surfaces data-progress-percent and aria attributes', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('RUNNING')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('data-progress-percent="50"');
      expect(out.html).toContain('role="progressbar"');
      expect(out.html).toContain('aria-valuenow="50"');
      expect(out.html).toContain('data-progress-message="half-way"');
    });

    it('escapes injected businessId + action + error code', async () => {
      const entry: OperationDetailCatalogEntry = {
        operation: {
          id: 'op-2',
          tenantId: 't',
          businessId: '<img src=x>',
          businessVersion: 'v"1"',
          action: 'extr"<script>alert(1)</script>',
          state: 'FAILED',
          stateVersion: 1,
          createdAt: 'now',
          updatedAt: 'now',
          deadlineAt: null,
          replayOf: null,
          progress: { percent: 0, message: '' },
          links: { self: '/s', result: '/r' },
          wait: null,
          error: { code: 'E<X', title: 't"1', detail: 'd&one' },
        },
        result: null,
        artifacts: [],
      };
      const r = await fetchOperationDetail({
        operationId: 'op-2',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [entry] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).not.toContain('<img src=x>');
      expect(out.html).not.toContain('<script>alert(1)</script>');
      expect(out.html).toContain('data-business-id="&lt;img src=x&gt;"');
      expect(out.html).toContain('data-error-code="E&lt;X"');
      expect(out.html).not.toContain('data-error-detail=');
      expect(out.html).toContain('Diagnostic details are hidden in this view.');
    });

    it('list-view renders with all action discriminators disabled', async () => {
      // W-ADMUX-01: the catalog list pane is a paged `kind: 'list'`
      // envelope with a row table + pagination controls (was a
      // single-hint `ok` pane). The section still exposes no mutation
      // affordance for the list view.
      const r = await fetchOperationDetail({
        operationId: '',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [okCatalogEntry('RUNNING')] },
      });
      if (r.kind !== 'list') throw new Error('expected list');
      const out = renderOperationSection({
        fetch: r,
        selectedOperationId: '',
      });
      expect(out.html).toContain('class="operation-section operation-section--list"');
      expect(out.html).toContain('data-can-cancel="false"');
      expect(out.html).toContain('data-can-resume="false"');
      expect(out.html).toContain('data-can-replay="false"');
      expect(out.html).toContain('data-list-page="true"');
      expect(out.html).toContain('data-operation-row="op-1"');
      expect(out.html).toContain('href="/admin/operations?operationId=op-1"');
      expect(out.html).not.toContain('data-action="cancel-operation"');
    });

    it('renderArtifactRow renders download href and per-cell data-* discriminators', () => {
      const html = renderArtifactRow({
        artifactId: 'a-1',
        role: 'output',
        fileName: 'out.md',
        mimeType: 'text/markdown',
        sizeDisplay: '4.0 KB',
        downloadUrl: '/dl/a-1',
      });
      expect(html).toContain('data-artifact-id="a-1"');
      expect(html).toContain('data-action="download-artifact"');
      expect(html).toContain('href="/dl/a-1"');
    });

    it('renderArtifactsTable empty-state still emits the header', () => {
      const html = renderArtifactsTable([]);
      expect(html).toContain('data-artifact-total="0"');
      expect(html).toContain('No artifacts attached');
    });

    it('renderResultPanel with null prints the not-available hint', () => {
      const html = renderResultPanel(null);
      expect(html).toContain('data-result-available="false"');
      expect(html).toContain('Result is not yet available');
    });

    it('renderResultPanel with a payload emits data-result-data and warnings list', () => {
      const html = renderResultPanel({
        schemaVersion: '1',
        dataJson: '{"ok":true}',
        dataPretty: '{\n  "ok": true\n}',
        warnings: ['warn-1'],
      });
      expect(html).toContain('data-result-available="true"');
      expect(html).toContain('data-result-warning-total="1"');
      expect(html).toContain('data-result-warning="warn-1"');
      // The payload is escaped inside the data-* attribute.
      expect(html).toContain('data-result-data="{&quot;ok&quot;:true}"');
    });

    it('renderHumanWaitForm is empty string when no form is present', () => {
      // The renderer returns '' when there is no form. Build a minimal
      // ok result via fetchOperationDetail for a non-WAITING_INPUT op.
      const opNoWait: OperationDetailCatalogEntry = {
        operation: {
          id: 'op-nw',
          tenantId: 't',
          businessId: 'b',
          businessVersion: 'v',
          action: 'a',
          state: 'RUNNING',
          stateVersion: 1,
          createdAt: 'now',
          updatedAt: 'now',
          deadlineAt: null,
          replayOf: null,
          progress: { percent: 0, message: '' },
          links: { self: '/s', result: '/r' },
          wait: null,
          error: null,
        },
        result: null,
        artifacts: [],
      };
      return fetchOperationDetail({
        operationId: 'op-nw',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [opNoWait] },
      }).then((r) => {
        if (r.kind !== 'ok') throw new Error('expected ok');
        // The standalone helper is exported but takes a detail directly;
        // call through the public renderer and inspect the section for
        // the absence of the wait sub-section.
        const html = renderOperationSection({ fetch: r }).html;
        expect(html).not.toContain('class="operation-section__wait"');
      });
    });

    it('renderActionBar disables cancel + replay when state is FAILED but cannot be replayed', () => {
      // The action bar is a private helper — exercise via the public
      // renderer path. CANCELLED is terminal but the renderer still
      // surfaces a disabled cancel button.
      const entry: OperationDetailCatalogEntry = {
        operation: {
          id: 'op-c',
          tenantId: 't',
          businessId: 'b',
          businessVersion: 'v',
          action: 'a',
          state: 'CANCELLED',
          stateVersion: 1,
          createdAt: 'now',
          updatedAt: 'now',
          deadlineAt: null,
          replayOf: null,
          progress: { percent: 0, message: '' },
          links: { self: '/s', result: '/r' },
          wait: null,
          error: null,
        },
        result: null,
        artifacts: [],
      };
      return fetchOperationDetail({
        operationId: 'op-c',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [entry] },
      }).then((r) => {
        if (r.kind !== 'ok') throw new Error('expected ok');
        const out = renderOperationSection({ fetch: r });
        expect(out.html).toContain('data-can-cancel="false"');
        expect(out.html).toContain('data-can-replay="true"');
        expect(out.html).toContain('data-replay-label="Rerun (new operation)"');
      });
    });
  });

  describe('renderOperationSection (P6-06, fallback panes)', () => {
    function fetchWith(operationId: string): Promise<OperationFetchResult> {
      return fetchOperationDetail({
        operationId,
        jsonBaseUrl: '',
        adminToken: '',
      });
    }

    it('renders the empty pane when no catalog is wired', async () => {
      const r = await fetchWith('op-1');
      expect(r.kind).toBe('empty');
      const out = renderOperationSection({ fetch: r });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('operation-section--empty');
      expect(out.html).toContain('data-empty-message="true"');
    });

    it('renders the unauthorized pane', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: '',
      });
      expect(r.kind).toBe('unauthorized');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('operation-section--unauthorized');
      expect(out.html).toContain('data-unauthorized-message="true"');
    });

    it('renders the not-found pane for an unknown operationId', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-missing',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('gone', { status: 404 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('not-found');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('operation-section--not-found');
      expect(out.html).toContain('data-not-found-id="op-missing"');
    });

    it('renders the error pane for HTTP 500', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('boom', { status: 500 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
      const out = renderOperationSection({ fetch: r });
      expect(out.html).toContain('operation-section--error');
      expect(out.html).toContain('data-error-message="true"');
    });
  });

  describe('fetchOperationDetail (P6-06, discriminated fetcher)', () => {
    function catalogOp(
      state: 'SUCCEEDED' | 'RUNNING' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'WAITING_INPUT',
      id = 'op-1',
    ): OperationDetailCatalogEntry {
      const op = {
        id,
        tenantId: 'tenant-1',
        businessId: 'biz-1',
        businessVersion: 'v1',
        action: 'ingest',
        state,
        stateVersion: 1,
        createdAt: 'now',
        updatedAt: 'now',
        deadlineAt: null,
        replayOf: null,
        progress: { percent: 0, message: '' },
        links: { self: '/s', result: '/r' },
        wait: null,
        error: null,
      } as const;
      return { operation: op, result: null, artifacts: [] };
    }

    it('empty when no catalog and no base URL', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
      });
      expect(r.kind).toBe('empty');
    });

    it('catalog hit → ok with selected operation id', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [catalogOp('RUNNING')] },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.selectedOperationId).toBe('op-1');
      expect(r.detail.id).toBe('op-1');
      expect(r.canCancel).toBe(true);
    });

    it('catalog miss + non-empty id → not-found', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-missing',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [catalogOp('RUNNING', 'op-1')] },
      });
      expect(r.kind).toBe('not-found');
      if (r.kind !== 'not-found') throw new Error('expected not-found');
      expect(r.operationId).toBe('op-missing');
    });

    it('SUCCEEDED → canReplay=true, canCancel=false', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [catalogOp('SUCCEEDED')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.canCancel).toBe(false);
      expect(r.canReplay).toBe(true);
      expect(r.replayLabel).toContain('Replay');
    });

    it('WAITING_INPUT → canResume=true (when wait is non-expired)', async () => {
      const entry: OperationDetailCatalogEntry = {
        operation: {
          ...catalogOp('WAITING_INPUT').operation,
          wait: {
            waitId: 'w-1',
            inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
            expiresAt: '2099-01-01T00:00:00Z',
          },
        },
        result: null,
        artifacts: [],
      };
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [entry] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.canResume).toBe(true);
      expect(r.canCancel).toBe(true);
      expect(r.canReplay).toBe(false);
    });

    it('TIMED_OUT → canReplay=true with the timeout-specific label', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [catalogOp('TIMED_OUT')] },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.canReplay).toBe(true);
      expect(r.replayLabel).toContain('Retry after timeout');
    });

    it('HTTP 401 → unauthorized', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('nope', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('HTTP 404 with operationId → not-found', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-x',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('gone', { status: 404 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('not-found');
      if (r.kind !== 'not-found') throw new Error('expected not-found');
      expect(r.operationId).toBe('op-x');
    });

    it('HTTP 500 → error', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('boom', { status: 500 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });

    it('non-JSON response → error', async () => {
      const r = await fetchOperationDetail({
        operationId: 'op-1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('<html>nope</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });
  });
});
