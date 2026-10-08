/** F-6: API-key tenant selection is backed by the tenant roster, offline. */
import { fetchApiKeys } from '../src/app/admin/api-key-section-data';
import { renderApiKeySection } from '../src/app/admin/api-key-section-renderer';

const BASE = 'https://orchestrator.example.test';
const TOKEN = 'f6-admin-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function offlineFetch(rosterResponse: Response): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/v1/admin/tenants')) return rosterResponse;
    if (url.includes('/api/v1/admin/api-keys')) {
      return jsonResponse({
        items: [
          {
            id: 'key-alpha',
            tenantId: TENANT_A,
            maskedHint: 'du_l…',
            prefix: 'du_live_',
            status: 'ACTIVE',
            createdAt: '2026-10-08T00:00:00Z',
          },
        ],
        total: 1,
        limit: 100,
      });
    }
    throw new Error(`Unexpected offline URL: ${url}`);
  };
  return { calls, fetchImpl };
}

describe('F-6 API-key tenant select (offline)', () => {
  it('renders roster names as labels and preserves form/CSRF semantics', async () => {
    const { calls, fetchImpl } = offlineFetch(jsonResponse({
      items: [
        { id: TENANT_A, name: 'Alpha tenant', state: 'ACTIVE' },
        { id: TENANT_B, name: 'Beta & Co', state: 'SUSPENDED' },
      ],
      nextCursor: null,
      prevCursor: null,
      total: 2,
      limit: 200,
    }));
    const result = await fetchApiKeys({
      keyId: '',
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl,
    });
    const html = renderApiKeySection({ fetch: result, csrfToken: 'f6-csrf-proof' }).html;

    expect(html).toContain('<select name="tenantId" aria-label="Tenant" required>');
    expect(html).toContain('<option value="" selected>Select a tenant</option>');
    expect(html).toContain(`<option value="${TENANT_A}">Alpha tenant</option>`);
    expect(html).toContain(`<option value="${TENANT_B}">Beta &amp; Co (SUSPENDED)</option>`);
    expect(html).not.toContain(`>${TENANT_A}</option>`);
    expect(html).not.toContain(`>${TENANT_B}</option>`);
    expect(html).not.toMatch(/<input[^>]*name="tenantId"/);
    expect(html).toContain('<form method="POST" action="/admin/api-keys/new"');
    expect(html).toContain('<input type="hidden" name="csrf" value="f6-csrf-proof">');
    expect(calls.some((url) => url.includes('/api/v1/admin/tenants'))).toBe(true);
  });

  it('fails closed when roster loading fails and a current tenant is absent', async () => {
    const { fetchImpl } = offlineFetch(jsonResponse({ message: 'private roster error' }, 503));
    const result = await fetchApiKeys({
      keyId: 'key-alpha',
      jsonBaseUrl: BASE,
      adminToken: TOKEN,
      fetchImpl,
    });
    const html = renderApiKeySection({ fetch: result, csrfToken: 'f6-csrf-proof' }).html;

    expect(html).toContain('<select name="tenantId" aria-label="Tenant" required>');
    expect(html).toContain('<option value="" selected>Select a tenant</option>');
    expect(html).not.toContain(`<option value="${TENANT_A}"`);
    expect(html).not.toContain('private roster error');
    expect(html).not.toMatch(/<input[^>]*name="tenantId"/);
    expect(html).toContain('<form method="POST" action="/admin/api-keys/new"');
    expect(html).toContain('<input type="hidden" name="csrf" value="f6-csrf-proof">');
  });
});
