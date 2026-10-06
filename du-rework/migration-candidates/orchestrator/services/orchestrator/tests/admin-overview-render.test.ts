/**
 * Focused renderer/fetcher tests for P6-07 overview.
 * Fixtures stay local to this pane; no shared fixture builder is needed.
 */

import { renderOverviewSection } from '../src/app/admin/overview-section-renderer';
import { fetchOverview } from '../src/app/admin/overview-section-data';
import type { OverviewCatalog } from '../src/app/admin/overview-section-data';

describe("admin-overview renderer (P6-07)", () => {
// P6-07 — Usage / audit / operational overview + role gate + screen states
  // ---------------------------------------------------------------------------

  describe('renderOverviewSection (P6-07, ok pane)', () => {
    function okCatalog(): OverviewCatalog {
      return {
        usageSummary: {
          tenantId: 'tenant_a',
          from: '2026-09-24T00:00:00.000Z',
          to: '2026-09-24T23:59:59.000Z',
          rows: [
            {
              provider: 'openai',
              model: 'gpt-4o-mini',
              operations: 12,
              inputTokens: 1000,
              outputTokens: 2000,
              pages: 5,
              costMicrousd: 250000,
              measurement: 'measured',
            },
            {
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              operations: 7,
              inputTokens: 800,
              outputTokens: 1500,
              pages: 3,
              costMicrousd: 175000,
              measurement: 'estimated',
            },
          ],
          totals: {
            operations: 19,
            inputTokens: 1800,
            outputTokens: 3500,
            pages: 8,
            costMicrousd: 425000,
          },
        },
        auditEvents: {
          tenantId: 'tenant_a',
          events: [
            {
              id: 'evt-1',
              kind: 'operation.complete',
              severity: 'success',
              occurredAt: '2026-09-24T10:00:00.000Z',
              tenantId: 'tenant_a',
              resourceId: 'op_42',
              actor: 'system',
              message: 'Operation completed.',
            },
            {
              id: 'evt-2',
              kind: 'apikey.revoke',
              severity: 'warning',
              occurredAt: '2026-09-24T11:30:00.000Z',
              tenantId: 'tenant_a',
              resourceId: 'key_7',
              actor: 'admin:bearer',
              message: 'Key revoked by admin.',
            },
          ],
        },
        health: {
          status: 'ok',
          db: true,
          redis: true,
          activeLeases: 3,
        },
      };
    }

    it('emits the full DOM evidence for the ok pane (usage + audit + health)', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: okCatalog(),
      });
      expect(r.kind).toBe('ok');
      const out = renderOverviewSection({ fetch: r });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('data-overview-tenant="tenant_a"');
      expect(out.html).toContain('data-overview-usage-available="true"');
      expect(out.html).toContain('data-overview-audit-available="true"');
      expect(out.html).toContain('data-overview-health-available="true"');
      expect(out.html).toContain('data-usage-total="2"');
      expect(out.html).toContain('data-usage-tenant="tenant_a"');
      expect(out.html).toContain('data-usage-row="openai|gpt-4o-mini"');
      expect(out.html).toContain('data-usage-measurement="measured"');
      expect(out.html).toContain('data-usage-measurement-badge="success"');
      expect(out.html).toContain('data-usage-measurement="estimated"');
      expect(out.html).toContain('data-usage-measurement-badge="warning"');
      expect(out.html).toContain('data-usage-totals-ops="19"');
      expect(out.html).toContain('data-usage-totals-input="1,800"');
      expect(out.html).toContain('data-usage-totals-output="3,500"');
      expect(out.html).toContain('data-usage-totals-pages="8"');
      expect(out.html).toContain('data-usage-totals-cost="$0.42"');
      expect(out.html).toContain('data-audit-total="2"');
      expect(out.html).toContain('data-audit-id="evt-1"');
      expect(out.html).toContain('data-audit-kind="operation.complete"');
      expect(out.html).toContain('data-audit-severity="success"');
      expect(out.html).toContain('data-audit-severity-badge="success"');
      expect(out.html).toContain('data-audit-severity="warning"');
      expect(out.html).toContain('data-audit-actor="system"');
      expect(out.html).toContain('data-audit-actor="admin:bearer"');
      expect(out.html).toContain('data-health-status="ok"');
      expect(out.html).toContain('data-health-fully-healthy="true"');
      expect(out.html).toContain('data-health-db="true"');
      expect(out.html).toContain('data-health-redis="true"');
      expect(out.html).toContain('data-health-leases="3"');
      expect(out.html).toContain('data-health-overall="ok"');
      expect(out.html).toContain('data-overview-tenant-selected="tenant_a"');
    });

    it('does not echo the raw bearer token in the rendered HTML', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: 'S3CRET-beArER',
        manifestCatalog: okCatalog(),
      });
      const out = renderOverviewSection({ fetch: r });
      expect(out.html).not.toContain('S3CRET-beArER');
      expect(out.html).not.toContain('Bearer ');
    });

    it('escapes injected values in the audit message + resource id', async () => {
      const cat = okCatalog();
      if (cat.auditEvents) {
        cat.auditEvents.events = [
          {
            id: 'evt-x',
            kind: 'operation.fail',
            severity: 'error',
            occurredAt: '2026-09-24T12:00:00.000Z',
            tenantId: 'tenant_a',
            resourceId: '<img src=x>',
            actor: '<script>alert(1)</script>',
            message: '"quoted" & <bold>',
          },
        ];
      }
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: cat,
      });
      const out = renderOverviewSection({ fetch: r });
      expect(out.html).not.toContain('<img src=x>');
      expect(out.html).not.toContain('<script>alert(1)</script>');
      expect(out.html).toContain('data-audit-resource="&lt;img src=x&gt;"');
      expect(out.html).toContain('data-audit-actor="&lt;script&gt;alert(1)&lt;/script&gt;"');
      expect(out.html).toContain('&quot;quoted&quot; &amp; &lt;bold&gt;');
    });
  });

  describe('renderOverviewSection (P6-07, fallback panes)', () => {
    it('empty pane renders when no catalog is provided', async () => {
      const r = await fetchOverview({
        tenantId: '',
        jsonBaseUrl: '',
        adminToken: '',
      });
      expect(r.kind).toBe('empty');
      const out = renderOverviewSection({ fetch: r });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('overview-section--empty');
      expect(out.html).toContain('data-empty-message="true"');
    });

    it('empty pane renders when the catalog has only zero rows and no health', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: {
          usageSummary: { tenantId: 'tenant_a', rows: [], totals: {} },
          auditEvents: { tenantId: 'tenant_a', events: [] },
          health: null,
        },
      });
      expect(r.kind).toBe('empty');
      const out = renderOverviewSection({ fetch: r });
      expect(out.html).toContain('overview-section--empty');
    });

    it('unauthorized pane renders when 401 is returned by the platform', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('nope', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
      const out = renderOverviewSection({ fetch: r });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('overview-section--unauthorized');
      expect(out.html).toContain('data-unauthorized-message="true"');
    });

    it('error pane renders when the platform returns 500', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('boom', { status: 500 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
      const out = renderOverviewSection({ fetch: r });
      expect(out.html).toContain('overview-section--error');
      expect(out.html).toContain('data-error-message="true"');
    });
  });

  describe('fetchOverview (P6-07, discriminated fetcher)', () => {
    function okCatalog(): OverviewCatalog {
      return {
        usageSummary: {
          tenantId: 'tenant_a',
          from: '2026-09-24T00:00:00.000Z',
          to: '2026-09-24T23:59:59.000Z',
          rows: [
            {
              provider: 'openai',
              model: 'gpt-4o-mini',
              operations: 1,
              inputTokens: 10,
              outputTokens: 20,
              pages: 1,
              costMicrousd: 1000,
              measurement: 'measured',
            },
          ],
          totals: { operations: 1, inputTokens: 10, outputTokens: 20, pages: 1, costMicrousd: 1000 },
        },
        auditEvents: null,
        health: null,
      };
    }

    it('returns ok when the catalog has at least one row', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: okCatalog(),
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.tenantId).toBe('tenant_a');
      expect(r.bundle.usage).not.toBeNull();
      expect(r.bundle.usage?.rows.length).toBe(1);
    });

    it('returns empty when no catalog and no jsonBaseUrl', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
      });
      expect(r.kind).toBe('empty');
    });

    it('returns unauthorized when jsonBaseUrl is set but adminToken is missing', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: '',
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('returns ok when all three endpoints return their wire shape', async () => {
      const calls: string[] = [];
      const okJson = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async (url: unknown) => {
          calls.push(String(url));
          const u = String(url);
          if (u.includes('/api/v1/usage')) {
            return okJson({
              tenantId: 'tenant_a',
              from: '2026-09-24T00:00:00.000Z',
              to: '2026-09-24T23:59:59.000Z',
              rows: [
                {
                  provider: 'openai',
                  model: 'gpt-4o-mini',
                  operations: 1,
                  inputTokens: 1,
                  outputTokens: 2,
                  pages: 1,
                  costMicrousd: 1000,
                  measurement: 'measured',
                },
              ],
              totals: { operations: 1, inputTokens: 1, outputTokens: 2, pages: 1, costMicrousd: 1000 },
            });
          }
          if (u.includes('/api/v1/admin/audit')) {
            return okJson({
              tenantId: 'tenant_a',
              events: [
                {
                  id: 'evt-1',
                  kind: 'operation.complete',
                  severity: 'success',
                  occurredAt: '2026-09-24T10:00:00.000Z',
                  tenantId: 'tenant_a',
                  resourceId: 'op_42',
                  actor: 'system',
                  message: 'done',
                },
              ],
            });
          }
          if (u.includes('/api/v1/health')) {
            return okJson({ status: 'ok', db: true, redis: true, activeLeases: 0 });
          }
          return new Response('not found', { status: 404 });
        }) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('ok');
      expect(calls.length).toBe(6);
    });

    it('returns unauthorized when any endpoint returns 401', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        fetchImpl: (async () =>
          new Response('nope', { status: 401 })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('unauthorized');
    });

    it('returns error on timeout', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 'tok',
        timeoutMs: 10,
        fetchImpl: (async (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          })) as unknown as typeof fetch,
      });
      expect(r.kind).toBe('error');
    });

    it('drops audit events whose tenantId does not match', async () => {
      const r = await fetchOverview({
        tenantId: 'tenant_a',
        jsonBaseUrl: '',
        adminToken: '',
        manifestCatalog: {
          usageSummary: null,
          auditEvents: {
            tenantId: 'tenant_b',
            events: [
              {
                id: 'evt-1',
                kind: 'operation.complete',
                severity: 'success',
                occurredAt: '2026-09-24T10:00:00.000Z',
                tenantId: 'tenant_b',
                resourceId: 'op_1',
                actor: 'system',
                message: 'cross-tenant leak attempt',
              },
              {
                id: 'evt-2',
                kind: 'operation.complete',
                severity: 'success',
                occurredAt: '2026-09-24T10:00:01.000Z',
                tenantId: 'tenant_a',
                resourceId: 'op_2',
                actor: 'system',
                message: 'in-tenant event',
              },
            ],
          },
          health: null,
        },
      });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.bundle.audit).not.toBeNull();
      expect(r.bundle.audit?.events.length).toBe(1);
      expect(r.bundle.audit?.events[0]?.id).toBe('evt-2');
    });
  });
});
