/**
 * P6-03 Profile section data seam.
 *
 * The rendered shell learns the schema-driven profile form by calling
 * the platform's JSON API. As of W40 the platform exposes
 * `POST /api/v1/admin/profile-bindings` (server.ts:762) but no
 * `GET /api/v1/admin/profiles/:businessId/:businessVersion/:name`
 * read-only route. The fetcher seam below is the single place the
 * shell calls out — when Claude Code lands the read route, this is
 * the one wire-up to change.
 *
 * Pure HTTP, no DB, no Redis. `fetchImpl` is injectable so the test
 * harness can drive the response without booting the platform. The
 * function returns a discriminated `ProfileFetchResult` so the
 * renderer can map every transport-level outcome (200 / 401 / 404 /
 * 5xx / network) onto the existing screen states without guessing.
 *
 * Headless fixtures: when no `jsonBaseUrl` is configured (e.g. the
 * shell is mounted without the platform's API URL), the fetcher
 * returns a deterministic in-process catalog so the renderer's
 * `ok` pane can be exercised end-to-end. The catalog comes from the
 * `manifestCatalog` parameter; tests pass a hand-built one, the
 * default is empty. This is the same "render the not-found pane
 * until Claude Code ships the route" pattern P6-02 uses for the
 * businesses section, plus a third `kind: 'ok-fixture'` arm for
 * offline integration tests.
 *
 * Strict TypeScript, zero `any`.
 */

import { sanitizeUpstreamErrorBody } from './upstream-error-body';
import type {
  ConnectorCapabilityOption,
  ProfileFormModel,
  ProfileSchemaInput,
} from './types';
import { buildProfileFormModel } from './profile-view-models';
import { safeTransportErrorText } from '../../http/errors';

// ---------------------------------------------------------------------------
// Wire shape (raw rows as the platform's GET would return them)
// ---------------------------------------------------------------------------

/**
 * Raw payload as it appears on the wire. Mirrors the slice of
 * `ActionManifest` the profile editor cares about, plus the slot
 * manifest per action (`connectorSlots`) the prompt-catalog column
 * uses. The fetcher normalises aliases (`promptSchema` →
 * `promptConfigSchema`, `modelOptions` → `allowedModelOptions`)
 * before handing rows to `buildProfileFormModel`.
 */
export interface ProfileManifestWireRow {
  businessId?: string;
  business_id?: string;
  businessVersion?: string;
  business_version?: string;
  profileName?: string;
  profile_name?: string;
  revision?: number;
  /** Optional current server values for each slot. */
  currentValues?: Record<string, string>;
  current_values?: Record<string, string>;
  manifest?: {
    actions?: Array<{
      name?: string;
      title?: string;
      displayName?: string;
      slots?: Array<{
        name?: string;
        required?: boolean;
        description?: string;
        widget?: string;
        options?: { value: string; label: string }[];
        /**
         * Locked slots are server-owned: the renderer marks the input
         * `readonly` + `disabled` and shows the locked value verbatim.
         * The server enforces this; the flag only drives display.
         */
        locked?: boolean;
        /** For locked slots: the current (server) value shown verbatim. */
        lockedValue?: string;
      }>;
      /** Slot-level prompt catalog metadata. */
      connectorSlots?: Array<{
        name?: string;
        promptConfigSchema?: Record<string, unknown>;
        promptSchema?: Record<string, unknown>;
        allowedModelOptions?: string[];
        modelOptions?: string[];
      }>;
    }>;
  };
  /** Server-side capability catalog — drives select-widget options. */
  capabilities?: Array<{
    connectorId?: string;
    connector_id?: string;
    capability?: string;
    label?: string;
  }>;
  capabilitiesOptions?: ConnectorCapabilityOption[];
}

// ---------------------------------------------------------------------------
// Fetcher input
// ---------------------------------------------------------------------------

/** Inputs the fetcher needs from the shell. */
export interface ProfileFetcherInput {
  /**
   * The business ID whose profile form to load. Driven by the
   * shell's `?businessId=…` query string. Empty string = the bare
   * `/admin/profiles` URL — the fetcher renders the "no business
   * selected" empty pane.
   */
  businessId: string;
  /**
   * The business version whose profile form to load. Driven by
   * `?businessVersion=…`. Optional: empty string triggers a "pick a
   * version" pane. When unset the renderer uses `latest` as a
   * visual marker only — never substituted into the wire call.
   */
  businessVersion?: string;
  /**
   * The profile name to load. Driven by `?profile=…`. Optional:
   * empty string renders the "new profile" pane.
   */
  profileName?: string;
  /** Base URL of the orchestrator JSON API (e.g. `http://127.0.0.1:2023`). */
  jsonBaseUrl: string;
  /**
   * Admin bearer token. Sent verbatim as `Authorization: Bearer …`
   * so the platform's `assertAdminAuth` admits the request. The shell
   * reuses the same token it signs the cookie with.
   */
  adminToken: string;
  /**
   * Injected fetch. Default = global `fetch`. Tests pass a stub.
   */
  fetchImpl?: typeof fetch;
  /**
   * Per-request timeout in ms. Default 4000.
   */
  timeoutMs?: number;
  /**
   * In-process manifest catalog used when no `jsonBaseUrl` is
   * configured (or the platform returns 404). Lets the renderer's
   * `ok` pane be exercised offline without booting the platform.
   * Empty by default — tests inject hand-built fixtures.
   */
  manifestCatalog?: readonly ProfileSchemaInput[];
  /**
   * Slot-level prompt-catalog metadata. When present, the renderer
   * renders the prompt-config keys per slot as a non-blocking hint.
   */
  promptCatalog?: ReadonlyMap<string, ReadonlyArray<string>>;
}

// ---------------------------------------------------------------------------
// Fetcher result (discriminated union — drives the renderer's screen state)
// ---------------------------------------------------------------------------

export type ProfileFetchResult =
  | {
      kind: 'ok';
      businessId: string;
      businessVersion: string;
      profileName: string;
      revision: number;
      model: ProfileFormModel;
      /**
       * Server's current slot values — used by the renderer to populate
       * field defaults. May be empty for new profiles.
       */
      currentValues: Readonly<Record<string, string>>;
      /**
       * Slot-level prompt catalog (per slot, the list of prompt-config
       * keys the slot exposes). Empty when the platform hasn't shipped
       * prompt metadata. Renderer shows it as a non-editable hint
       * column — it never invents entries.
       */
      promptCatalog: ReadonlyMap<string, ReadonlyArray<string>>;
      /**
       * For each slot whose original widget string did not match any
       * known `FieldWidget`, the original string. Used by the renderer
       * to expose `data-unknown-widget="<name>"` so operators can
       * trace the manifest mismatch. Empty for known widgets.
       */
      originalWidgetBySlot: ReadonlyMap<string, string>;
      /**
       * Slot names the server marked locked. The renderer marks those
       * inputs `readonly`/`disabled` + `data-locked="true"` so the
       * operator cannot edit a server-owned value. The server
       * re-validates on submit; this only drives display.
       */
      lockedBySlot: ReadonlySet<string>;
      /**
       * For locked slots, the current (server) value shown verbatim
       * as the input's default. The renderer never invents a value
       * for a locked slot.
       */
      lockedValueBySlot: ReadonlyMap<string, string>;
    }
  | {
      kind: 'unauthorized';
      businessId: string;
      message: string;
    }
  | {
      kind: 'not-found';
      businessId: string;
      message: string;
    }
  | {
      kind: 'empty';
      businessId: string;
      message: string;
    }
  | {
      kind: 'error';
      businessId: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normaliseCapabilities(
  raw: ProfileManifestWireRow,
): ConnectorCapabilityOption[] {
  if (Array.isArray(raw.capabilitiesOptions)) {
    return raw.capabilitiesOptions;
  }
  if (!Array.isArray(raw.capabilities)) return [];
  const out: ConnectorCapabilityOption[] = [];
  for (const c of raw.capabilities) {
    if (!c || typeof c !== 'object') continue;
    const connectorId = c.connectorId ?? c.connector_id;
    const capability = c.capability;
    if (typeof connectorId !== 'string' || typeof capability !== 'string') continue;
    const label =
      typeof c.label === 'string' && c.label.length > 0 ? c.label : `${connectorId}/${capability}`;
    out.push({ connectorId, capability, label });
  }
  return out;
}

function normaliseSlots(
  action: NonNullable<NonNullable<ProfileManifestWireRow['manifest']>['actions']>[number],
): NonNullable<ProfileSchemaInput['manifest']['actions'][number]['slots']> {
  const slots = Array.isArray(action.slots) ? action.slots : [];
  return slots
    .filter((s): s is NonNullable<typeof s> => s !== null && typeof s === 'object')
    .map((s) => {
      const out: NonNullable<ProfileSchemaInput['manifest']['actions'][number]['slots']>[number] = {
        name: typeof s.name === 'string' && s.name.length > 0 ? s.name : '',
      };
      if (typeof s.required === 'boolean') out.required = s.required;
      if (typeof s.description === 'string' && s.description.length > 0) {
        out.description = s.description;
      }
      if (typeof s.widget === 'string' && s.widget.length > 0) out.widget = s.widget;
      if (Array.isArray(s.options) && s.options.length > 0) out.options = s.options;
      return out;
    })
    .filter((s) => s.name.length > 0);
}

function normaliseManifest(raw: ProfileManifestWireRow): ProfileSchemaInput {
  const actions = Array.isArray(raw.manifest?.actions) ? raw.manifest!.actions! : [];
  return {
    businessId: raw.businessId ?? '',
    businessVersion: raw.businessVersion ?? '',
    manifest: {
      actions: actions
        .filter((a): a is NonNullable<typeof a> => a !== null && typeof a === 'object')
        .map((a) => {
          const title = a.title ?? a.displayName ?? a.name ?? '';
          const actionOut: ProfileSchemaInput['manifest']['actions'][number] = {
            name: typeof a.name === 'string' && a.name.length > 0 ? a.name : title,
          };
          if (typeof title === 'string' && title.length > 0) actionOut.title = title;
          actionOut.slots = normaliseSlots(a);
          return actionOut;
        })
        .filter((a) => a.name.length > 0),
    },
    capabilityOptions: normaliseCapabilities(raw),
    existingProfile:
      typeof raw.profileName === 'string' && raw.profileName.length > 0
        ? {
            name: raw.profileName,
            revision: typeof raw.revision === 'number' ? raw.revision : 0,
          }
        : null,
  };
}

/**
 * Replicates the view-model's `mapSchemaToWidget` "unknown" detection
 * so the fetcher can decorate unknown slots with the original widget
 * string. The renderer uses the decoration to surface
 * `data-unknown-widget="<name>"`. We intentionally keep this small
 * and conservative — the view-model is the source of truth.
 */
function collectUnknownWidgetSources(
  raw: ProfileManifestWireRow,
): ReadonlyMap<string, string> {
  const KNOWN = new Set<string>([
    'text',
    'textarea',
    'number',
    'boolean',
    'select',
    'secret',
    'readonly-hint',
  ]);
  const out = new Map<string, string>();
  const actions = Array.isArray(raw.manifest?.actions) ? raw.manifest!.actions! : [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const slots = Array.isArray(a.slots) ? a.slots : [];
    for (const s of slots) {
      if (!s || typeof s !== 'object') continue;
      const name = typeof s.name === 'string' ? s.name : '';
      if (name.length === 0) continue;
      const candidate = typeof s.widget === 'string' ? s.widget : '';
      if (candidate.length > 0 && !KNOWN.has(candidate)) {
        out.set(name, candidate);
      }
    }
  }
  return out;
}

/**
 * Collect the slots the wire payload marked locked, plus their
 * server-owned values. Mirrors `collectUnknownWidgetSources`: the
 * renderer consumes the result without re-parsing the payload.
 */
function collectLockedSlots(raw: ProfileManifestWireRow): {
  lockedBySlot: ReadonlySet<string>;
  lockedValueBySlot: ReadonlyMap<string, string>;
} {
  const lockedBySlot = new Set<string>();
  const lockedValueBySlot = new Map<string, string>();
  const actions = Array.isArray(raw.manifest?.actions) ? raw.manifest!.actions! : [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const slots = Array.isArray(a.slots) ? a.slots : [];
    for (const s of slots) {
      if (!s || typeof s !== 'object') continue;
      const name = typeof s.name === 'string' ? s.name : '';
      if (name.length === 0) continue;
      if (s.locked === true) {
        lockedBySlot.add(name);
        lockedValueBySlot.set(name, typeof s.lockedValue === 'string' ? s.lockedValue : '');
      }
    }
  }
  return { lockedBySlot, lockedValueBySlot };
}

/**
 * Look up the headless fixture for `(businessId, businessVersion, profileName)`.
 * Returns `undefined` when no fixture matches. The caller falls back to the
 * platform HTTP path or the not-found pane.
 */
function pickCatalogEntry(
  input: ProfileFetcherInput,
  businessId: string,
  businessVersion: string,
  profileName: string,
): ProfileSchemaInput | undefined {
  const catalog = input.manifestCatalog ?? [];
  if (catalog.length === 0) return undefined;
  // Exact match.
  for (const entry of catalog) {
    if (entry.businessId !== businessId) continue;
    if (entry.businessVersion !== businessVersion) continue;
    if ((entry.existingProfile?.name ?? '') !== profileName) continue;
    return entry;
  }
  // `latest` may resolve to the most recently available fixture, but an
  // explicit version must never silently show another revision as if it
  // matched the requested one. A named profile also requires an exact name
  // match even on the latest-version path.
  if (businessVersion.length > 0 && businessVersion !== 'latest') return undefined;
  for (const entry of catalog) {
    if (entry.businessId !== businessId) continue;
    if (profileName.length > 0 && (entry.existingProfile?.name ?? '') !== profileName) continue;
    return entry;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch the schema-driven profile form model for the given
 * (businessId, businessVersion, profileName) from the orchestrator
 * JSON API. Returns a discriminated result the renderer can map onto
 * a screen state. **Never throws** — transport errors collapse into
 * `{ kind: 'error', ... }` so the shell stays fail-closed at the HTTP
 * layer.
 *
 * When `businessId === ''`, the fetcher returns `kind: 'empty'` so
 * the renderer shows the "Pick a business first" pane instead of
 * guessing one.
 */
export async function fetchProfileForm(
  input: ProfileFetcherInput,
): Promise<ProfileFetchResult> {
  const businessId = input.businessId;
  const businessVersion = input.businessVersion ?? '';
  const profileName = input.profileName ?? '';

  if (businessId.length === 0) {
    return {
      kind: 'empty',
      businessId,
      message: 'Pick a business to open its profile editor.',
    };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 4000;

  if (!input.jsonBaseUrl) {
    // No platform API configured — fall back to the in-process catalog
    // (tests only; production always configures `jsonBaseUrl`).
    const catalogEntry = pickCatalogEntry(input, businessId, businessVersion, profileName);
    if (catalogEntry) {
      return buildOkFromCatalog(catalogEntry, input.promptCatalog);
    }
    return {
      kind: 'not-found',
      businessId,
      message: `Business '${businessId}' has no manifest registered on the shell yet.`,
    };
  }
  if (!input.adminToken) {
    return {
      kind: 'unauthorized',
      businessId,
      message: 'Admin bearer token is not configured.',
    };
  }

  let url: URL;
  try {
    const path =
      `/api/v1/admin/profiles/${encodeURIComponent(businessId)}` +
      (businessVersion.length > 0
        ? `/${encodeURIComponent(businessVersion)}`
        : '/latest') +
      (profileName.length > 0 ? `/${encodeURIComponent(profileName)}` : '/new');
    url = new URL(path, input.jsonBaseUrl);
  } catch {
    return {
      kind: 'error',
      businessId,
      message: 'Invalid platform JSON API base URL.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.adminToken}`,
        accept: 'application/json',
        'x-correlation-id': `p6-03-${Date.now().toString(36)}`,
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'unauthorized',
        businessId,
        message: `Platform rejected the admin token (HTTP ${res.status}).`,
      };
    }
    if (res.status === 404) {
      return {
        kind: 'not-found',
        businessId,
        message: `No manifest is available for '${businessId}' on the platform (HTTP 404).`,
      };
    }
    if (!res.ok) {
      const body = sanitizeUpstreamErrorBody(await res.text().catch(() => ''));
      return {
        kind: 'error',
        businessId,
        message: `Platform returned HTTP ${res.status}${body ? `: ${body}` : ''}`,
      };
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        kind: 'error',
        businessId,
        message: 'Platform returned non-JSON for the profile endpoint.',
      };
    }
    return parseFetchPayload(parsed, input.promptCatalog);
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    return {
      kind: 'error',
      businessId,
      message: aborted
        ? `Timed out after ${timeoutMs}ms waiting for the platform.`
        : safeTransportErrorText('Network error contacting the platform'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildOkFromCatalog(
  entry: ProfileSchemaInput,
  promptCatalog?: ReadonlyMap<string, ReadonlyArray<string>>,
  originalWidgetBySlot?: ReadonlyMap<string, string>,
): ProfileFetchResult {
  const model = buildProfileFormModel(entry);
  const revision = entry.existingProfile?.revision ?? 0;
  return {
    kind: 'ok',
    businessId: entry.businessId,
    businessVersion: entry.businessVersion,
    profileName: entry.existingProfile?.name ?? '',
    revision,
    model,
    currentValues: Object.freeze({}),
    promptCatalog: promptCatalog ?? new Map(),
    originalWidgetBySlot: originalWidgetBySlot ?? collectUnknownWidgetsFromEntry(entry),
    // The in-process catalog carries no server-ownership metadata
    // (ProfileSchemaInput has no `locked` field); locks only travel
    // over the platform HTTP path.
    lockedBySlot: new Set<string>(),
    lockedValueBySlot: new Map<string, string>(),
  };
}

function collectUnknownWidgetsFromEntry(
  entry: ProfileSchemaInput,
): ReadonlyMap<string, string> {
  const KNOWN = new Set<string>([
    'text',
    'textarea',
    'number',
    'boolean',
    'select',
    'secret',
    'readonly-hint',
  ]);
  const out = new Map<string, string>();
  for (const a of entry.manifest.actions) {
    const slots = a.slots ?? [];
    for (const s of slots) {
      const candidate = s.widget;
      if (candidate !== undefined && candidate.length > 0 && !KNOWN.has(candidate)) {
        out.set(s.name, candidate);
      }
    }
  }
  return out;
}

function parseFetchPayload(
  raw: unknown,
  promptCatalog?: ReadonlyMap<string, ReadonlyArray<string>>,
): ProfileFetchResult {
  if (!raw || typeof raw !== 'object') {
    return {
      kind: 'error',
      businessId: '',
      message: 'Platform returned an unexpected payload shape (not an object).',
    };
  }
  const obj = raw as ProfileManifestWireRow;
  const businessId = obj.businessId ?? obj.business_id ?? '';
  const businessVersion = obj.businessVersion ?? obj.business_version ?? '';
  const profileName = obj.profileName ?? obj.profile_name ?? '';
  const revision = typeof obj.revision === 'number' ? obj.revision : 0;
  const currentValuesRaw = obj.currentValues ?? obj.current_values ?? {};
  const currentValues: Readonly<Record<string, string>> = Object.freeze(
    currentValuesRaw && typeof currentValuesRaw === 'object' ? (currentValuesRaw as Record<string, string>) : {},
  );
  if (businessId.length === 0) {
    return {
      kind: 'error',
      businessId: '',
      message: 'Platform payload did not carry a businessId.',
    };
  }
  const input = normaliseManifest(obj);
  if (input.manifest.actions.length === 0) {
    return {
      kind: 'empty',
      businessId,
      message: `Manifest for '${businessId}' declares no actions yet.`,
    };
  }
  const model = buildProfileFormModel(input);
  const locks = collectLockedSlots(obj);
  return {
    kind: 'ok',
    businessId,
    businessVersion,
    profileName,
    revision,
    model,
    currentValues,
    promptCatalog: promptCatalog ?? new Map(),
    originalWidgetBySlot: collectUnknownWidgetSources(obj),
    lockedBySlot: locks.lockedBySlot,
    lockedValueBySlot: locks.lockedValueBySlot,
  };
}
