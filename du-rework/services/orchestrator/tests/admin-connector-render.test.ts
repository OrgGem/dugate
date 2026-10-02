/**
 * Focused renderer/fetcher tests for P6-04 connector.
 * Fixtures stay local to this pane; no shared fixture builder is needed.
 */

import { renderConnectorSection, renderConnectorSecretSlot, renderConnectorTestAction, countConfiguredSecrets } from '../src/app/admin/connector-section-renderer';
import { fetchConnectorConfig } from '../src/app/admin/connector-section-data';

describe("admin-connector renderer (P6-04)", () => {
// -------------------------------------------------------------------------
  // P6-04 — connector config / secret rotation / test result UI
  // -------------------------------------------------------------------------

  describe('renderConnectorSection (P6-04, ok pane)', () => {
    // Build an `ok` fetch result directly so the renderer is exercised
    // without going through the catalog fallback path. The view models
    // already include sanitized badges + masks, so the result is
    // renderer-safe by construction.
    const okFetch = (): import('../src/app/admin/connector-section-data').ConnectorFetchResult => ({
      kind: 'ok',
      connectorId: 'openai',
      revision: 7,
      revisionView: {
        connectorId: 'openai',
        revision: 7,
        adapter: 'openai-adapter',
        endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
        capabilities: ['gpt-4', 'gpt-3.5-turbo'],
        state: 'enabled',
        stateBadge: 'success',
        stateLabel: 'Enabled',
        createdAt: '2026-09-23T10:00:00Z',
        updatedAt: '2026-09-23T18:00:00Z',
        secretSlots: [
          {
            name: 'apiKey',
            label: 'API key',
            hasValue: true,
            statusBadge: 'success',
            statusLabel: 'Configured',
            rotatedAt: '2026-09-22T10:00:00Z',
          },
          {
            name: 'webhookSecret',
            label: 'Webhook secret',
            hasValue: false,
            statusBadge: 'neutral',
            statusLabel: 'Not configured',
            rotatedAt: null,
          },
        ],
        totalSecretSlots: 2,
        hasAnySecret: true,
      },
      testResult: {
        kind: 'success',
        message: 'Connected to upstream in 134 ms.',
        label: 'Success',
        badge: 'success',
        connectorId: 'openai',
        revision: 7,
        testedAt: '2026-09-23T18:00:00Z',
        canRetry: false,
      },
      rotateState: 'idle',
      secretSlotViews: [
        {
          name: 'apiKey',
          label: 'API key',
          hasValue: true,
          statusBadge: 'success',
          statusLabel: 'Configured',
          rotatedAt: '2026-09-22T10:00:00Z',
        },
        {
          name: 'webhookSecret',
          label: 'Webhook secret',
          hasValue: false,
          statusBadge: 'neutral',
          statusLabel: 'Not configured',
          rotatedAt: null,
        },
      ],
      revisionRow: {
        connectorId: 'openai',
        revision: 7,
        adapter: 'openai-adapter',
        endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
        capabilities: ['gpt-4', 'gpt-3.5-turbo'],
        state: 'enabled',
        createdAt: '2026-09-23T10:00:00Z',
        updatedAt: '2026-09-23T18:00:00Z',
      },
      revisionLabel: '#7',
    });

    it('isReady=true and renders the section root with revision label', () => {
      const out = renderConnectorSection({ fetch: okFetch() });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('<section class="connector-section"');
      expect(out.html).toContain('data-connector-id="openai"');
      expect(out.html).toContain('data-revision="7"');
      expect(out.html).toContain('data-revision-label="#7"');
    });

    it('write-only secret slot: empty type=password input, raw value never rendered', () => {
      const out = renderConnectorSection({ fetch: okFetch() });
      // The slot exists with the right name + label.
      expect(out.html).toContain('data-slot="apiKey"');
      expect(out.html).toContain('API key');
      // Write-only contract: password field, empty value, explicit marker.
      expect(out.html).toContain('type="password"');
      expect(out.html).toContain('name="value"');
      expect(out.html).toContain('autocomplete="off"');
      expect(out.html).toContain('data-write-only="true"');
      // The Configured / Not configured badges are surfaced; the raw
      // value is never rendered.
      expect(out.html).toContain('data-secret-state="configured"');
      expect(out.html).toContain('Configured');
      expect(out.html).toContain('data-secret-state="not-configured"');
      expect(out.html).not.toContain('sk-');
    });

    it('explicit test result: data-test-result-kind + sanitized message, no upstream leak', () => {
      const out = renderConnectorSection({ fetch: okFetch() });
      expect(out.html).toContain('data-test-result-kind="success"');
      expect(out.html).toContain('data-test-result="success"');
      expect(out.html).toContain('data-tested-at="2026-09-23T18:00:00Z"');
      expect(out.html).toContain('Connected to upstream in 134 ms.');
      // The button is the explicit test-action affordance.
      expect(out.html).toContain('data-action="test-connection"');
    });

    it('renders the picker when knownConnectorIds is supplied', () => {
      const out = renderConnectorSection({
        fetch: okFetch(),
        knownConnectorIds: ['openai', 'anthropic'],
        selectedConnectorId: 'openai',
        selectedRevision: 7,
      });
      expect(out.html).toContain('class="connector-section__picker"');
      expect(out.html).toContain('name="connectorId"');
      expect(out.html).toContain('value="7"');
    });

    it('renderConnectorSecretSlot enforces write-only contract when standalone', () => {
      const out = renderConnectorSecretSlot('openai', 7, {
        name: 'apiKey',
        label: 'API key',
        hasValue: true,
        statusBadge: 'success',
        statusLabel: 'Configured',
        rotatedAt: '2026-09-22T10:00:00Z',
      });
      expect(out).toContain('type="password"');
      expect(out).toContain('value=""');
      expect(out).toContain('data-write-only="true"');
      expect(out).not.toContain('sk-');
    });

    it('renderConnectorTestAction surfaces failure + pending states with sanitized message', () => {
      const failure = renderConnectorTestAction({
        kind: 'invalid-credential',
        message: 'Authentication failed: upstream rejected the credential.',
        label: 'Failure',
        badge: 'error',
        connectorId: 'openai',
        revision: 7,
        testedAt: null,
        canRetry: false,
      });
      expect(failure).toContain('data-test-result-kind="failure"');
      expect(failure).toContain('data-test-result="invalid-credential"');
      expect(failure).toContain('Authentication failed');

      const pending = renderConnectorTestAction({
        kind: 'pending',
        message: 'Test queued.',
        label: 'Pending',
        badge: 'neutral',
        connectorId: 'openai',
        revision: 7,
        testedAt: null,
        canRetry: false,
      });
      expect(pending).toContain('data-test-result-kind="pending"');
      expect(pending).toContain('data-test-result="pending"');
    });

    it('countConfiguredSecrets returns the hasValue=true count', () => {
      const slots = [
        {
          name: 'apiKey',
          label: 'API key',
          hasValue: true,
          statusBadge: 'success' as const,
          statusLabel: 'Configured',
          rotatedAt: '2026-09-22T10:00:00Z',
        },
        {
          name: 'webhookSecret',
          label: 'Webhook secret',
          hasValue: false,
          statusBadge: 'neutral' as const,
          statusLabel: 'Not configured',
          rotatedAt: null,
        },
      ];
      expect(renderConnectorSection({ fetch: okFetch() })).toBeTruthy();
      expect(countConfiguredSecrets(slots)).toBe(1);
    });
  });

  describe('renderConnectorSection (P6-04, fallback panes)', () => {
    it('empty pane when no connector is selected', () => {
      const out = renderConnectorSection({
        fetch: {
          kind: 'empty',
          connectorId: '',
          message: 'Pick a connector to open its configuration pane.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('connector-section--empty');
      expect(out.html).toContain('Pick a connector');
      expect(out.html).not.toContain('type="password"');
    });

    it('unauthorized pane when the admin token is rejected', () => {
      const out = renderConnectorSection({
        fetch: {
          kind: 'unauthorized',
          connectorId: 'openai',
          message: 'Platform rejected the admin token (HTTP 401).',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('connector-section--unauthorized');
      expect(out.html).toContain('Admin token rejected');
      expect(out.html).not.toContain('type="password"');
    });

    it('not-found pane when the GET route is missing on the platform', () => {
      const out = renderConnectorSection({
        fetch: {
          kind: 'not-found',
          connectorId: 'openai',
          message: "Connector 'openai' revision 'latest' is not on the server.",
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('connector-section--not-found');
      expect(out.html).toContain('not registered');
      expect(out.html).not.toContain('type="password"');
    });

    it('error pane on transport failure', () => {
      const out = renderConnectorSection({
        fetch: {
          kind: 'error',
          connectorId: 'openai',
          message: 'Network error contacting the platform.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('connector-section--error');
      expect(out.html).toContain('Network error');
      expect(out.html).not.toContain('type="password"');
    });
  });

  describe('fetchConnectorConfig (P6-04, discriminated fetcher)', () => {
    const baseEntry = {
      connectorId: 'openai',
      revision: 7,
      adapter: 'openai-adapter',
      endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
      capabilities: ['gpt-4'],
      state: 'enabled' as const,
      createdAt: '2026-09-23T10:00:00Z',
      updatedAt: '2026-09-23T18:00:00Z',
      secretSlots: [
        { name: 'apiKey', label: 'API key', hasValue: true, rotatedAt: '2026-09-22T10:00:00Z' },
      ],
      testResult: { kind: 'success' as const, message: 'OK', testedAt: '2026-09-23T18:00:00Z' },
      rotateState: 'idle' as const,
    };

    it('empty connectorId → empty discriminated result (no fabricated data)', async () => {
      const r = await fetchConnectorConfig({
        connectorId: '',
        revision: 0,
        jsonBaseUrl: '',
        adminToken: 'tok',
        fetchImpl: (() => { throw new Error('should not be called'); }) as typeof fetch,
      });
      expect(r.kind).toBe('empty');
    });

    it('catalog match → ok pane with write-only slot (no raw value in any view)', async () => {
      const r = await fetchConnectorConfig({
        connectorId: 'openai',
        revision: 7,
        jsonBaseUrl: '',
        adminToken: 'tok',
        manifestCatalog: [baseEntry],
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      expect(r.revisionLabel).toBe('#7');
      const out = renderConnectorSection({ fetch: r });
      expect(out.html).toContain('type="password"');
      expect(out.html).toContain('value=""');
      expect(out.html).not.toContain('sk-');
    });

    it('catalog miss with no platform → not-found discriminated result', async () => {
      const r = await fetchConnectorConfig({
        connectorId: 'missing',
        revision: 0,
        jsonBaseUrl: '',
        adminToken: 'tok',
        manifestCatalog: [baseEntry],
      });
      expect(r.kind).toBe('not-found');
    });

    it('HTTP 401 → unauthorized discriminated result (no fetcher ok pane)', async () => {
      const r = await fetchConnectorConfig({
        connectorId: 'openai',
        revision: 7,
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('denied', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('HTTP 404 → not-found discriminated result', async () => {
      const r = await fetchConnectorConfig({
        connectorId: 'openai',
        revision: 7,
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('missing', { status: 404 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('not-found');
    });
  });
});
