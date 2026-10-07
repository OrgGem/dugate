/**
 * Focused renderer/fetcher tests for P6-03 profile.
 * Fixtures stay local to this pane; no shared fixture builder is needed.
 */

import { renderProfileSection } from '../src/app/admin/profile-section-renderer';
import { fetchProfileForm } from '../src/app/admin/profile-section-data';
import { buildProfileFormModel } from '../src/app/admin/profile-view-models';

describe("admin-profile renderer (P6-03)", () => {
// -------------------------------------------------------------------------
  // P6-03 — dynamic schema profile editor (slots/defaults/locked/prompt cat.)
  // -------------------------------------------------------------------------

  describe('renderProfileSection (P6-03, ok pane)', () => {
    const baseSchema = {
      businessId: 'example-review',
      businessVersion: 'v1',
      manifest: {
        actions: [
          {
            name: 'analyze',
            title: 'Analyze',
            slots: [
              { name: 'model', required: true, widget: 'text', description: 'Model id' },
              { name: 'temperature', required: false, widget: 'number' },
              { name: 'prompt', required: true, widget: 'textarea', description: 'Prompt template' },
              { name: 'apiKey', required: true, widget: 'secret' },
            ],
          },
          {
            name: 'compare',
            title: 'Compare',
            slots: [
              { name: 'pair', required: true, widget: 'select', options: [
                { value: 'openai/gpt-4', label: 'openai/gpt-4' },
                { value: 'anthropic/claude', label: 'anthropic/claude' },
              ] },
              { name: 'exotic', required: false, widget: 'fusion-turbo' },
            ],
          },
        ],
      },
      capabilityOptions: [
        { connectorId: 'openai', capability: 'gpt-4', label: 'openai/gpt-4' },
        { connectorId: 'anthropic', capability: 'claude', label: 'anthropic/claude' },
      ],
      existingProfile: { name: 'p-default', revision: 7 },
    };

    it('isReady=true and renders the form with a section per action', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({}),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      expect(out.isReady).toBe(true);
      expect(out.html).toContain('<section class="profile-section"');
      expect(out.html).toContain('data-business-id="example-review"');
      expect(out.html).toContain('data-revision="7"');
      expect(out.html).toContain('data-action="analyze"');
      expect(out.html).toContain('data-action="compare"');
    });

    it('renders each slot as a labeled input with the right widget type', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({
          model: 'openai/gpt-4',
          temperature: '0.5',
          prompt: 'Analyze {{doc}}',
          apiKey: 'sk-1234567890',
          pair: 'anthropic/claude',
        }),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      // Text input
      expect(out.html).toContain('data-slot="model"');
      expect(out.html).toContain('data-widget="text"');
      expect(out.html).toContain('value="openai/gpt-4"');
      // Number input
      expect(out.html).toContain('data-slot="temperature"');
      expect(out.html).toContain('type="number"');
      expect(out.html).toContain('value="0.5"');
      // Textarea
      expect(out.html).toContain('data-slot="prompt"');
      expect(out.html).toContain('field-input--textarea');
      // Secret: existing value masked as bullets, never the raw key
      expect(out.html).toContain('data-slot="apiKey"');
      expect(out.html).toContain('type="password"');
      expect(out.html).toContain('value="••••••••"');
      expect(out.html).not.toContain('sk-1234567890');
      // Select with option
      expect(out.html).toContain('data-slot="pair"');
      expect(out.html).toContain('selected');
      expect(out.html).toContain('anthropic/claude');
    });

    it('renders the prompt catalog hint when a slot has prompt keys', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({}),
        promptCatalog: new Map<string, readonly string[]>([
          ['model', ['system', 'user', 'assistant']],
        ]),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      expect(out.html).toContain('field-prompt-catalog');
      expect(out.html).toContain('Prompt catalog');
      expect(out.html).toContain('<code>system</code>');
      expect(out.html).toContain('<code>user</code>');
      expect(out.html).toContain('<code>assistant</code>');
    });

    it('flags unknown widgets with the fallback banner and data attribute', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({}),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map<string, string>([['exotic', 'fusion-turbo']]),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      expect(out.html).toContain('profile-section__unknown-banner');
      expect(out.html).toContain('Unknown widget');
      // The exotic slot falls back to text but keeps the unknown source name.
      expect(out.html).toContain('data-unknown-widget="fusion-turbo"');
      expect(out.html).toContain('data-unknown-fallback="true"');
    });

    it('renders locked slots readonly + disabled with the server value verbatim', () => {
      const fixture = renderProfileSection({
        fetch: {
          kind: 'ok' as const,
          businessId: 'example-review',
          businessVersion: 'v1',
          profileName: 'p-default',
          revision: 7,
          model: buildProfileFormModel(baseSchema),
          // A stale client value that MUST NOT win over the lock.
          currentValues: Object.freeze({ model: 'client-supplied-model' }),
          promptCatalog: new Map(),
          originalWidgetBySlot: new Map(),
          lockedBySlot: new Set<string>(['model']),
          lockedValueBySlot: new Map<string, string>([['model', 'server-owned-model']]),
        },
      });
      // The locked field carries the marker + class.
      expect(fixture.html).toContain('field--locked');
      expect(fixture.html).toContain('data-locked="true"');
      expect(fixture.html).toContain('field-locked-mark');
      expect(fixture.html).toContain('readonly');
      expect(fixture.html).toContain('disabled');
      // The server value is shown verbatim; the client value is ignored.
      expect(fixture.html).toContain('value="server-owned-model"');
      expect(fixture.html).not.toContain('value="client-supplied-model"');
      // An unlocked sibling is still editable (no readonly/disabled).
      expect(fixture.html).toContain('data-slot="temperature"');
      expect(fixture.html).not.toContain('data-slot="temperature" data-widget="number" disabled');
    });

    it('never renders a lock marker when no slot is locked', () => {
      const fixture = renderProfileSection({
        fetch: {
          kind: 'ok' as const,
          businessId: 'example-review',
          businessVersion: 'v1',
          profileName: 'p-default',
          revision: 7,
          model: buildProfileFormModel(baseSchema),
          currentValues: Object.freeze({}),
          promptCatalog: new Map(),
          originalWidgetBySlot: new Map(),
          lockedBySlot: new Set<string>(),
          lockedValueBySlot: new Map<string, string>(),
        },
      });
      expect(fixture.html).not.toContain('data-locked="true"');
      expect(fixture.html).not.toContain('field-locked-mark');
      expect(fixture.html).not.toContain('field--locked');
    });

    it('renders the business picker when knownBusinessIds is supplied', () => {
      const fetch = {
        kind: 'ok' as const,
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        model: buildProfileFormModel(baseSchema),
        currentValues: Object.freeze({}),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({
        fetch,
        knownBusinessIds: ['example-review', 'document-core'],
        selectedBusinessId: 'example-review',
      });
      expect(out.html).toContain('class="profile-section__picker"');
      expect(out.html).toContain('name="businessId"');
      expect(out.html).toContain('selected');
    });

    it('escapes malicious slot names and values', () => {
      const evil: typeof baseSchema = {
        businessId: '<img>',
        businessVersion: 'v1',
        manifest: {
          actions: [
            {
              name: '<script>',
              title: '</title>',
              slots: [
                { name: 'a"><img src=x>', required: false, widget: 'text' },
              ],
            },
          ],
        },
        capabilityOptions: [],
        existingProfile: { name: '', revision: 0 },
      };
      const fetch = {
        kind: 'ok' as const,
        businessId: '<img>',
        businessVersion: 'v1',
        profileName: '',
        revision: 0,
        model: buildProfileFormModel(evil),
        currentValues: Object.freeze({ 'a"><img src=x>': '<bad>' }),
        promptCatalog: new Map(),
        originalWidgetBySlot: new Map(),
        lockedBySlot: new Set<string>(),
        lockedValueBySlot: new Map<string, string>(),
      };
      const out = renderProfileSection({ fetch });
      expect(out.html).not.toContain('<img src=x>');
      expect(out.html).not.toContain('<script>');
      // esc() turns the angle brackets into HTML entities.
      expect(out.html).toContain('data-business-id="&lt;img&gt;"');
      expect(out.html).not.toContain('<bad>');
      expect(out.html).toContain('&lt;bad&gt;');
    });
  });

  describe('renderProfileSection (P6-03, fallback panes)', () => {
    it('renders the empty pane when no business is selected', () => {
      const out = renderProfileSection({
        fetch: {
          kind: 'empty',
          businessId: '',
          message: 'Pick a business to open its profile editor.',
        },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('profile-section--empty');
      expect(out.html).toContain('Pick a business');
    });

    it('renders the unauthorized pane on 401/403', () => {
      const out = renderProfileSection({
        fetch: { kind: 'unauthorized', businessId: 'a', message: 'token rejected' },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('profile-section--unauthorized');
      expect(out.html).toContain('token rejected');
    });

    it('renders the not-found pane when no manifest is registered', () => {
      const out = renderProfileSection({
        fetch: { kind: 'not-found', businessId: 'a', message: 'no manifest' },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('profile-section--not-found');
      expect(out.html).toContain('no manifest');
    });

    it('renders the error pane on network/timeout', () => {
      const out = renderProfileSection({
        fetch: { kind: 'error', businessId: 'a', message: 'Timed out after 4000ms' },
      });
      expect(out.isReady).toBe(false);
      expect(out.html).toContain('profile-section--error');
      expect(out.html).toContain('Timed out');
    });
  });

  describe('fetchProfileForm (P6-03, discriminated fetcher)', () => {
    it('returns empty when no businessId is supplied', async () => {
      const fetchImpl = jest.fn();
      const res = await fetchProfileForm({
        businessId: '',
        jsonBaseUrl: 'http://127.0.0.1:0',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('empty');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns unauthorized when no adminToken is supplied', async () => {
      const fetchImpl = jest.fn();
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:0',
        adminToken: '',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('unauthorized');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('falls back to the in-process catalog when jsonBaseUrl is empty', async () => {
      const res = await fetchProfileForm({
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        jsonBaseUrl: '',
        adminToken: 't',
        manifestCatalog: [baseSchemaForCatalog()],
      });
      expect(res.kind).toBe('ok');
      if (res.kind === 'ok') {
        expect(res.businessId).toBe('example-review');
        expect(res.model.sections.map((s) => s.actionName)).toEqual(['analyze']);
      }
    });

    it('returns not-found when the catalog has no matching entry', async () => {
      const res = await fetchProfileForm({
        businessId: 'absent',
        jsonBaseUrl: '',
        adminToken: 't',
        manifestCatalog: [],
      });
      expect(res.kind).toBe('not-found');
    });

    it('returns unauthorized on HTTP 401 from the platform', async () => {
      const fetchImpl = jest.fn(async () => new Response('nope', { status: 401 }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('unauthorized');
    });

    it('returns not-found on HTTP 404 from the platform', async () => {
      const fetchImpl = jest.fn(async () => new Response('', { status: 404 }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('not-found');
    });

    it('returns error on HTTP 500 with the sanitized body', async () => {
      const fetchImpl = jest.fn(async () => new Response('boom', { status: 500 }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.message).toContain('HTTP 500');
        expect(res.message).toContain('boom');
      }
    });

    it('returns error when the platform returns non-JSON', async () => {
      const fetchImpl = jest.fn(async () => new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.message).toContain('non-JSON');
      }
    });

    it('parses a successful platform payload into the ok result', async () => {
      const payload = {
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 7,
        currentValues: { model: 'openai/gpt-4' },
        manifest: {
          actions: [
            {
              name: 'analyze',
              title: 'Analyze',
              slots: [
                { name: 'model', required: true, widget: 'text' },
              ],
            },
          ],
        },
      };
      const fetchImpl = jest.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
      const res = await fetchProfileForm({
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('ok');
      if (res.kind === 'ok') {
        expect(res.revision).toBe(7);
        expect(res.currentValues['model']).toBe('openai/gpt-4');
        expect(res.model.sections).toHaveLength(1);
      }
    });

    it('carries wire locks into lockedBySlot/lockedValueBySlot (P6-03 locks)', async () => {
      const payload = {
        businessId: 'example-review',
        businessVersion: 'v1',
        profileName: 'p-default',
        revision: 9,
        currentValues: { model: 'openai/gpt-4' },
        manifest: {
          actions: [
            {
              name: 'analyze',
              title: 'Analyze',
              slots: [
                { name: 'model', required: true, widget: 'text' },
                {
                  name: 'tenantTag',
                  required: false,
                  widget: 'text',
                  locked: true,
                  lockedValue: 'tenant-acme',
                },
                { name: 'exotic', required: false, widget: 'fusion-turbo' },
              ],
            },
          ],
        },
      };
      const fetchImpl = jest.fn(
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const res = await fetchProfileForm({
        businessId: 'example-review',
        businessVersion: 'v1',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('ok');
      if (res.kind !== 'ok') return;
      expect(res.lockedBySlot.has('tenantTag')).toBe(true);
      expect(res.lockedBySlot.has('model')).toBe(false);
      expect(res.lockedValueBySlot.get('tenantTag')).toBe('tenant-acme');
      // The unknown-widget source still rides alongside the lock set.
      expect(res.originalWidgetBySlot.get('exotic')).toBe('fusion-turbo');
    });

    it('returns empty when the manifest declares no actions', async () => {
      const payload = {
        businessId: 'a',
        businessVersion: 'v1',
        profileName: 'p',
        revision: 0,
        currentValues: {},
        manifest: { actions: [] },
      };
      const fetchImpl = jest.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.kind).toBe('empty');
    });

    it('returns error on timeout (AbortError)', async () => {
      const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
        // Simulate the AbortController firing: throw an AbortError.
        return new Promise<Response>((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });
      const res = await fetchProfileForm({
        businessId: 'a',
        jsonBaseUrl: 'http://127.0.0.1:1',
        adminToken: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 25,
      });
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.message).toMatch(/Timed out|aborted/i);
      }
    });

    function baseSchemaForCatalog() {
      return {
        businessId: 'example-review',
        businessVersion: 'v1',
        manifest: {
          actions: [
            {
              name: 'analyze',
              title: 'Analyze',
              slots: [
                { name: 'model', required: true, widget: 'text' },
              ],
            },
          ],
        },
        capabilityOptions: [],
        existingProfile: { name: 'p-default', revision: 7 },
      };
    }
  });
});
