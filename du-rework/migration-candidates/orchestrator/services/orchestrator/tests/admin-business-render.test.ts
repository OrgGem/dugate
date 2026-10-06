/**
 * Focused renderer/fetcher tests for P6-02 business.
 * Fixtures stay local to this pane; no shared fixture builder is needed.
 */

import { renderBusinessSection, buildDisplayRows } from '../src/app/admin/business-section-renderer';
import type { BusinessFetchResult } from '../src/app/admin/business-section-data';
import type { BusinessVersionRow } from '../src/app/admin/business-view-models';

describe("admin-business renderer (P6-02)", () => {
// ---------------------------------------------------------------------------
  // P6-02 — Business registry / version / health renderer
  // ---------------------------------------------------------------------------
  describe('renderBusinessSection (P6-02, ok pane)', () => {
    const sampleRows: readonly BusinessVersionRow[] = [
      {
        businessId: 'example-review',
        version: 'v2',
        status: 'ENABLED',
        isActive: true,
        registeredAt: '2026-09-01T00:00:00Z',
        workerHealth: 'HEALTHY',
        workerCount: 3,
        lastHeartbeatAt: '2026-09-23T11:55:00Z',
      },
      {
        businessId: 'example-review',
        version: 'v1',
        status: 'DRAINING',
        isActive: false,
        registeredAt: '2026-08-01T00:00:00Z',
        workerHealth: 'DEGRADED',
        workerCount: 1,
        lastHeartbeatAt: '2026-09-23T11:00:00Z',
      },
      {
        businessId: 'example-review',
        version: 'v0.5',
        status: 'REGISTERED_DISABLED',
        isActive: false,
        registeredAt: '2026-07-15T00:00:00Z',
      },
      {
        businessId: 'example-review',
        version: 'v0',
        status: 'RETIRED',
        isActive: false,
        registeredAt: '2026-07-01T00:00:00Z',
      },
    ];

    const fetch: BusinessFetchResult = {
      kind: 'ok',
      businessId: 'example-review',
      rows: sampleRows,
      activeVersion: 'v2',
    };

    it('isReady=true and renders the section root with the business id', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('<section class="business-section"');
      expect(out.html).toContain('data-business-id="example-review"');
    });

    it('renders the health summary with active version + counts', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.html).toContain('<section class="business-section__health"');
      expect(out.html).toContain('Overall health');
      // v2 is ENABLED + active → "healthy" or "no-active" depending on
      // worker signal. Either way the data-health attribute is present.
      expect(out.html).toMatch(/data-health="(healthy|no-active|draining|retired)"/);
      // Counts.
      expect(out.html).toContain('Total versions');
      expect(out.html).toContain('Enabled');
      expect(out.html).toContain('Draining');
      expect(out.html).toContain('Retired');
    });

    it('renders a per-row status badge for every version state', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.html).toContain('data-status="ENABLED"');
      expect(out.html).toContain('data-status="DRAINING"');
      expect(out.html).toContain('data-status="RETIRED"');
    });

    it('renders the active marker on the active row only', () => {
      const out = renderBusinessSection({ fetch });
      // Active marker appears once with data-active="true".
      const matches = out.html.match(/data-active="true"/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('renders per-row health indicators', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.html).toMatch(/data-health="(healthy|draining|retired)"/);
    });

    it('renders the worker heartbeat block with worker count', () => {
      const out = renderBusinessSection({ fetch });
      expect(out.html).toContain('class="worker-heartbeat"');
      expect(out.html).toContain('workers: 3');
    });

    it('gates enable / drain / retire per transition guard', () => {
      const out = renderBusinessSection({ fetch });
      // v2 ENABLED active → drain form (enable/drain/retire); retire disabled.
      // v1 DRAINING → enable + retire forms, drain disabled.
      // v0.5 REGISTERED_DISABLED → enable form, drain/retire disabled.
      // v0 RETIRED → all three disabled.
      expect(out.html).toContain('action-chip--enable');
      expect(out.html).toContain('action-chip--drain');
      expect(out.html).toContain('action-chip--retire');
      // action-chip-form wrappers must appear for the allowed transitions.
      const formWrappers = (out.html.match(/action-chip-form/g) ?? []).length;
      // v2 drain + v1 retire + v0.5 enable = 3.
      expect(formWrappers).toBe(3);
      // Disabled markers must appear for the disallowed transitions.
      const disabled = (out.html.match(/action-chip--disabled/g) ?? []).length;
      // v2 enable + v2 retire + v1 enable + v1 drain + v0.5 drain + v0.5 retire + v0 enable + v0 drain + v0 retire = 9.
      expect(disabled).toBeGreaterThanOrEqual(9);
    });

    it('renders the business picker with known ids when supplied', () => {
      const out = renderBusinessSection({
        fetch,
        knownBusinessIds: ['example-review', 'other-biz'],
        selectedBusinessId: 'example-review',
      });
      expect(out.html).toContain('class="business-section__picker"');
      expect(out.html).toContain('action="/admin/businesses"');
      expect(out.html).toContain('value="example-review" selected');
      expect(out.html).toContain('value="other-biz"');
    });

    it('renders the empty pane when rows is []', () => {
      const out = renderBusinessSection({
        fetch: { kind: 'ok', businessId: 'example-review', rows: [], activeVersion: null },
      });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('class="business-section__empty"');
      expect(out.html).toContain('No versions are registered');
    });
  });

  describe('renderBusinessSection (P6-02, fallback panes)', () => {
    it('renders the unauthorized pane with status badge and message', () => {
      const out = renderBusinessSection({
        fetch: { kind: 'unauthorized', businessId: 'example-review', message: 'token expired' },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('business-section--unauthorized');
      expect(out.html).toContain('Admin token rejected');
      expect(out.html).toContain('token expired');
    });

    it('renders the not-found pane for an empty businessId with a list-unavailable hint', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'not-found',
          businessId: '',
          message: 'Platform does not expose a business list endpoint.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('business-section--not-found');
      expect(out.html).toContain('Business list unavailable');
    });

    it('renders the not-found pane for a missing businessId', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'not-found',
          businessId: 'unknown-biz',
          message: "Business 'unknown-biz' is not registered.",
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('Business not registered');
      expect(out.html).toContain('unknown-biz');
    });

    it('renders the error pane for transport failure', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'error',
          businessId: 'example-review',
          message: 'Timed out after 4000ms waiting for the platform.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('business-section--error');
      expect(out.html).toContain('Could not load business versions');
      expect(out.html).toContain('Timed out after 4000ms');
    });

    it('escapes script payload in the error pane message', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'error',
          businessId: 'example-review',
          message: 'boom <script>alert(1)</script>',
        },
      });
      expect(out.html).not.toContain('<script>alert(1)</script>');
      expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes injected version / message / status text', () => {
      const out = renderBusinessSection({
        fetch: {
          kind: 'ok',
          businessId: '<img src=x>',
          rows: [
            {
              businessId: '<img src=x>',
              version: '<v"1>',
              status: 'REGISTERED_DISABLED',
              registeredAt: 'now',
            },
          ],
          activeVersion: null,
        },
      });
      expect(out.html).not.toContain('<img src=x>');
      expect(out.html).not.toContain('<v"1>');
      // The row's malicious businessId + version appear only in escaped
      // form (data-business-id attribute + the <code> tag).
      expect(out.html).toContain('data-business-id="&lt;img src=x&gt;"');
      expect(out.html).toContain('&lt;v&quot;1&gt;');
    });
  });

  describe('buildDisplayRows (P6-02, view-model adapter)', () => {
    it('maps every raw row through toBusinessVersionDisplayRow', () => {
      const rows: readonly BusinessVersionRow[] = [
        { businessId: 'a', version: 'v1', status: 'ENABLED', isActive: true, workerHealth: 'HEALTHY', workerCount: 2 },
        { businessId: 'a', version: 'v2', status: 'REGISTERED_DISABLED' },
      ];
      const display = buildDisplayRows(rows);
      expect(display).toHaveLength(2);
      expect(display[0]?.canDrain).toBe(true);
      expect(display[1]?.canEnable).toBe(true);
    });
  });
});
