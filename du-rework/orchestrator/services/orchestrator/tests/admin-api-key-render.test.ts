/**
 * Focused renderer/fetcher tests for P6-05 API key.
 * Fixtures stay local to this pane; no shared fixture builder is needed.
 */

import { renderApiKeySection, renderApiKeyCopyOnceBanner, renderApiKeyRevokePanel, renderApiKeyGrantsTable } from '../src/app/admin/api-key-section-renderer';
import { fetchApiKeys } from '../src/app/admin/api-key-section-data';
import type { ApiKeyCatalogEntry } from '../src/app/admin/api-key-section-data';
import { buildApiKeyCreateView } from '../src/app/admin/api-key-view-models';

describe("admin API-key renderer (P6-05)", () => {
// -------------------------------------------------------------------------
  // P6-05 — API key create / copy-once / revoke / assignment
  // -------------------------------------------------------------------------
  //
  // Hard rule: the renderer MUST never carry a raw API key value.
  // The DOM-evidence tests below assert (a) the masked hint is the
  // only key material visible, (b) `data-copy-once-available` is
  // the single explicit discriminator on the copy-once banner,
  // (c) the revoke panel exposes `data-can-revoke` and disables
  // the confirm button when the key is not in ACTIVE state, and
  // (d) the assignment table renders the grant rows from the
  // fetcher without leaking raw key material.

  describe('renderApiKeySection (P6-05, ok pane)', () => {
    const okCatalog: ApiKeyCatalogEntry[] = [
      {
        id: 'k_alpha',
        tenantId: 'tenant-1',
        maskedHint: 'abcd…',
        prefix: 'du_live_',
        status: 'ACTIVE',
        createdAt: '2026-09-20T00:00:00Z',
        lastUsedAt: '2026-09-22T00:00:00Z',
        label: 'CI runner',
        revokedAt: null,
        grants: [
          {
            businessId: 'biz-1',
            businessVersion: 'v1',
            action: 'ingest',
            grantedAt: '2026-09-20T01:00:00Z',
          },
        ],
      },
      {
        id: 'k_bravo',
        tenantId: 'tenant-1',
        maskedHint: 'wxyz…',
        prefix: 'du_live_',
        status: 'REVOKED',
        createdAt: '2026-09-15T00:00:00Z',
        lastUsedAt: null,
        label: null,
        revokedAt: '2026-09-19T00:00:00Z',
        grants: [],
      },
    ];

    const okResult = async () =>
      fetchApiKeys({
        keyId: '',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });

    it('isReady=true and data-copy-once-available="false" when no copy-once window is open', async () => {
      const r = await okResult();
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      const out = renderApiKeySection({ fetch: r, knownKeyIds: ['k_alpha', 'k_bravo'] });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('data-key-total="2"');
      expect(out.html).toContain('data-key-selected=""');
      expect(out.html).toContain('data-copy-once-available="false"');
      // No raw key material anywhere in the rendered HTML.
      expect(out.html).not.toMatch(/du_live_[a-zA-Z0-9]{20,}/);
    });

    it('lists every row with its masked hint + status badge + canRevoke flag', async () => {
      const r = await okResult();
      if (r.kind !== 'ok') throw new Error('expected ok');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('data-key-id="k_alpha"');
      expect(html).toContain('data-key-status="ACTIVE"');
      expect(html).toContain('data-key-masked="abcd…"');
      expect(html).toContain('data-key-id="k_bravo"');
      expect(html).toContain('data-key-status="REVOKED"');
    });

    it('renders the detail panel + grants table for the selected key', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_alpha',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('<section class="api-key-section__detail"');
      expect(html).toContain('data-key-id="k_alpha"');
      expect(html).toContain('<section class="api-key-section__grants"');
      expect(html).toContain('data-grant-total="1"');
      expect(html).toContain('data-business-id="biz-1"');
      expect(html).toContain('data-business-version="v1"');
      expect(html).toContain('data-action="ingest"');
    });

    it('copy-once banner surfaces data-copy-once-available="true" + masked hint only', () => {
      const banner = renderApiKeyCopyOnceBanner(
        buildApiKeyCreateView({
          id: 'k_charlie',
          tenantId: 'tenant-1',
          prefix: 'du_live_',
          label: 'Temp',
          createdAt: '2026-09-23T00:00:00Z',
          rawKey: 'du_live_S3CRET_RAW_VALUE_LONG',
        }),
      );
      expect(banner).toContain('data-copy-once-available="true"');
      expect(banner).toContain('data-copy-once-id="k_charlie"');
      expect(banner).toContain('data-copy-once-masked="du_l…"');
      // The raw key value MUST NOT appear anywhere in the rendered
      // banner — the model discarded it before the renderer was
      // called.
      expect(banner).not.toContain('S3CRET_RAW_VALUE_LONG');
      expect(banner).not.toContain('data-copy-once-raw=');
    });

    it('revoke panel exposes data-can-revoke="false" + disabled for non-ACTIVE keys', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_bravo',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const selected = r.selected;
      expect(selected).not.toBeNull();
      const panel = renderApiKeyRevokePanel(selected!);
      expect(panel).toContain('data-key-id="k_bravo"');
      expect(panel).toContain('data-can-revoke="false"');
      expect(panel).toContain('data-action="revoke-api-key" disabled');
    });

    it('revoke panel exposes data-can-revoke="true" + enabled confirm for ACTIVE keys', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_alpha',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      if (r.kind !== 'ok') throw new Error('expected ok');
      const panel = renderApiKeyRevokePanel(r.selected!);
      expect(panel).toContain('data-can-revoke="true"');
      expect(panel).toContain('data-action="revoke-api-key"');
      expect(panel).not.toContain('data-action="revoke-api-key" disabled');
    });

    it('create form posts against /admin/api-keys/new and surfaces explicit data-action', async () => {
      const r = await okResult();
      if (r.kind !== 'ok') throw new Error('expected ok');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('action="/admin/api-keys/new"');
      expect(html).toContain('data-action="create-api-key"');
    });

    it('grants table renders grant rows from the fetcher result', () => {
      const grants = [
        {
          businessId: 'biz-9',
          businessVersion: 'v2',
          action: 'extract',
          grantedAt: '2026-09-23T01:00:00Z',
        },
      ];
      const html = renderApiKeyGrantsTable('k_alpha', grants);
      expect(html).toContain('data-grant-total="1"');
      expect(html).toContain('data-business-id="biz-9"');
      expect(html).toContain('data-action="extract"');
    });
  });

  describe('renderApiKeySection (P6-05, fallback panes)', () => {
    it('empty pane renders when the catalog has no entries', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [] },
      });
      expect(r.kind).toBe('empty');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('api-key-section--empty');
      expect(html).toContain('No API keys are registered yet');
    });

    it('unauthorized pane renders when adminToken is missing + jsonBaseUrl is set', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: '',
      });
      expect(r.kind).toBe('unauthorized');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('api-key-section--unauthorized');
      expect(html).toContain('Admin token rejected');
    });

    it('not-found pane renders when the requested keyId is unknown (catalog has the row missing)', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_missing',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: {
          entries: [
            {
              id: 'k_alpha',
              tenantId: 'tenant-1',
              maskedHint: 'abcd…',
              prefix: 'du_live_',
              status: 'ACTIVE',
              createdAt: '2026-09-20T00:00:00Z',
              lastUsedAt: null,
              label: null,
              revokedAt: null,
              grants: [],
            },
          ],
        },
      });
      expect(r.kind).toBe('not-found');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('api-key-section--not-found');
      expect(html).toContain('k_missing');
    });

    it('error pane renders on transport failure (timeout)', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        timeoutMs: 50,
        fetchImpl: (async () => {
          // Simulate an aborted request — the fetcher must surface
          // this as a discriminated `error` and the renderer must
          // show the error pane.
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
      const html = renderApiKeySection({ fetch: r }).html;
      expect(html).toContain('api-key-section--error');
    });
  });

  describe('fetchApiKeys (P6-05, discriminated fetcher)', () => {
    const okCatalog: ApiKeyCatalogEntry[] = [
      {
        id: 'k_alpha',
        tenantId: 'tenant-1',
        maskedHint: 'abcd…',
        prefix: 'du_live_',
        status: 'ACTIVE',
        createdAt: '2026-09-20T00:00:00Z',
        lastUsedAt: null,
        label: null,
        revokedAt: null,
        grants: [],
      },
    ];

    it('empty catalog + no keyId → empty result', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: [] },
      });
      expect(r.kind).toBe('empty');
    });

    it('catalog match + keyId → ok with selected row', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_alpha',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.selected?.id).toBe('k_alpha');
      expect(r.total).toBe(1);
    });

    it('catalog miss + non-empty keyId → not-found', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_missing',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: { entries: okCatalog },
      });
      expect(r.kind).toBe('not-found');
      if (r.kind !== 'not-found') throw new Error('expected not-found');
      expect(r.keyId).toBe('k_missing');
    });

    it('HTTP 401 → unauthorized', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('nope', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('HTTP 404 with keyId → not-found', async () => {
      const r = await fetchApiKeys({
        keyId: 'k_alpha',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('missing', { status: 404 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('not-found');
      if (r.kind !== 'not-found') throw new Error('expected not-found');
      expect(r.keyId).toBe('k_alpha');
    });

    it('HTTP 500 → error', async () => {
      const r = await fetchApiKeys({
        keyId: '',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('boom', { status: 500 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });

    it('non-JSON response → error', async () => {
      const r = await fetchApiKeys({
        keyId: '',
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
