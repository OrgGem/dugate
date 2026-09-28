/**
 * Profile Binding Test Fixture Helper (Wave 19-20 / W20-A)
 *
 * Implements client-side interaction with Orchestrator's published Admin profile-bindings route
 * (POST /api/v1/admin/profile-bindings) per P2-02 / R08-02 / W13-C / W20-A.
 *
 * Requirements:
 * 1. Uses the real published Admin route over HTTP; does NOT direct-SQL seed new profile bindings.
 * 2. Enforces manifest-backed per-action connectorBindings derived from documentCoreManifest:
 *    - extract, analyze, transform, generate, compare declare 'reasoning'
 *    - ingest declares 'ocr' and 'vision'
 * 3. Strictly validates action and slot declarations before HTTP side-effects.
 * 4. Rejects empty actions array and never silently returns an undefined profileId.
 * 5. Enforces fail-closed validation: no fallback to global connector config to mask auth failures.
 */

import { documentCoreManifest } from '../../src/manifest/document-core.manifest';

export interface SlotPinInput {
  connectorId: string;
  revision: number;
}

export type ConnectorBindingsMap = Record<string, SlotPinInput>;

export interface CreateProfileBindingRequest {
  profileId?: string;
  apiKey: string;
  businessId: string;
  businessVersion: string;
  action: string;
  connectorBindings: ConnectorBindingsMap;
}

export interface ProfileBindingResult {
  profileId: string;
  revision: number;
}

export interface ProfileBindingFixtureOptions {
  orchestratorUrl: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
}

export class ProfileBindingFixtureClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ProfileBindingFixtureOptions) {
    this.baseUrl = opts.orchestratorUrl.replace(/\/$/, '');
    this.adminToken = opts.adminToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Returns the declared connector slot names for an action from documentCoreManifest.
   * Throws if the action is not declared in the manifest.
   */
  public static getDeclaredSlotsForAction(action: string): string[] {
    const manifestAction = documentCoreManifest.actions.find((a) => a.name === action);
    if (!manifestAction) {
      throw new Error(`Undeclared action: "${action}" is not defined in documentCoreManifest`);
    }
    return manifestAction.connectorSlots.map((s) => s.name);
  }

  /**
   * Derives manifest-valid connectorBindings for a specified action:
   * - 'extract', 'analyze', 'transform', 'generate', 'compare' -> { reasoning: { connectorId, revision } }
   * - 'ingest' -> { ocr: ... } and/or { vision: ... } per tested variant (defaults to both or specified slot)
   */
  public static deriveManifestBindingsForAction(
    action: string,
    connectorId: string,
    revision: number,
    options?: { ingestSlot?: 'ocr' | 'vision' | 'both' }
  ): ConnectorBindingsMap {
    const declared = ProfileBindingFixtureClient.getDeclaredSlotsForAction(action);

    if (action === 'ingest') {
      const ingestSlot = options?.ingestSlot ?? 'both';
      if (ingestSlot === 'both') {
        return {
          ocr: { connectorId, revision },
          vision: { connectorId, revision },
        };
      }
      return {
        [ingestSlot]: { connectorId, revision },
      };
    }

    if (!declared.includes('reasoning')) {
      throw new Error(`Action "${action}" does not declare a reasoning slot in documentCoreManifest`);
    }

    return {
      reasoning: { connectorId, revision },
    };
  }

  /**
   * Appends an immutable profile revision for an API key via POST /api/v1/admin/profile-bindings.
   * Validates action and slot declarations against documentCoreManifest before making HTTP call.
   * Fails closed on error with descriptive typed error messages.
   */
  public async createRevision(req: CreateProfileBindingRequest): Promise<ProfileBindingResult> {
    // 1. Manifest-backed validation before HTTP side-effects
    const declaredSlots = ProfileBindingFixtureClient.getDeclaredSlotsForAction(req.action);

    if (!req.connectorBindings || typeof req.connectorBindings !== 'object' || Array.isArray(req.connectorBindings)) {
      throw new Error('connectorBindings must be an object mapping slots to { connectorId, revision }');
    }

    const slots = Object.keys(req.connectorBindings);
    if (slots.length === 0) {
      throw new Error(`connectorBindings must contain at least one slot pin for action "${req.action}"`);
    }

    for (const slot of slots) {
      if (!declaredSlots.includes(slot)) {
        throw new Error(
          `Undeclared connector slot "${slot}" for action "${req.action}". Declared slots in manifest: [${declaredSlots.join(', ')}]`
        );
      }
      const pin = req.connectorBindings[slot];
      if (
        !pin ||
        typeof pin.connectorId !== 'string' ||
        pin.connectorId.length === 0 ||
        typeof pin.revision !== 'number' ||
        !Number.isInteger(pin.revision) ||
        pin.revision < 1
      ) {
        throw new Error(
          `Invalid slot pin for "${slot}": connectorId must be a non-empty string and revision must be a positive integer`
        );
      }
    }

    // 2. HTTP Admin invocation
    const url = `${this.baseUrl}/api/v1/admin/profile-bindings`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.adminToken}`,
      },
      body: JSON.stringify(req),
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = { raw: text };
    }

    if (!res.ok) {
      const err = body as { code?: string; detail?: string; message?: string };
      const code = err?.code || `HTTP_${res.status}`;
      const msg = err?.detail || err?.message || text || `Request failed with status ${res.status}`;
      throw new Error(`ProfileBindingFailed [${code}]: ${msg}`);
    }

    const data = body as { profileId?: unknown; revision?: unknown };
    if (typeof data?.profileId !== 'string' || typeof data?.revision !== 'number') {
      throw new Error(`Invalid response schema from POST /api/v1/admin/profile-bindings: ${text}`);
    }

    return {
      profileId: data.profileId,
      revision: data.revision,
    };
  }

  /**
   * Binds specified actions using manifest-derived per-action connectorBindings.
   * Validates empty actions input explicitly and guarantees a non-undefined profileId is returned.
   */
  public async bindActions(opts: {
    profileId?: string;
    apiKey: string;
    businessId?: string;
    businessVersion?: string;
    actions?: string[];
    connectorId: string;
    connectorRevision: number;
    ingestSlot?: 'ocr' | 'vision' | 'both';
    perActionBindings?: Record<string, ConnectorBindingsMap>;
  }): Promise<{ profileId: string; revisionsByAction: Record<string, number> }> {
    if (opts.actions !== undefined && opts.actions.length === 0) {
      throw new Error('actions array must be non-empty');
    }

    const actions = opts.actions ?? ['extract', 'analyze', 'transform', 'generate', 'compare', 'ingest'];
    if (actions.length === 0) {
      throw new Error('actions array must be non-empty');
    }

    const businessId = opts.businessId ?? documentCoreManifest.businessId;
    const businessVersion = opts.businessVersion ?? documentCoreManifest.version;

    let resolvedProfileId = opts.profileId;
    const revisionsByAction: Record<string, number> = {};

    for (const action of actions) {
      const bindings =
        opts.perActionBindings?.[action] ??
        ProfileBindingFixtureClient.deriveManifestBindingsForAction(
          action,
          opts.connectorId,
          opts.connectorRevision,
          { ingestSlot: opts.ingestSlot }
        );

      const result = await this.createRevision({
        profileId: resolvedProfileId,
        apiKey: opts.apiKey,
        businessId,
        businessVersion,
        action,
        connectorBindings: bindings,
      });

      if (!resolvedProfileId) {
        resolvedProfileId = result.profileId;
      }
      revisionsByAction[action] = result.revision;
    }

    if (!resolvedProfileId) {
      throw new Error('Failed to resolve profileId: no actions were bound');
    }

    return {
      profileId: resolvedProfileId,
      revisionsByAction,
    };
  }

  /**
   * Convenience alias to bind all six document-core actions with manifest-correct slots.
   */
  public async bindDocumentCoreActions(opts: {
    profileId?: string;
    apiKey: string;
    connectorId: string;
    connectorRevision: number;
    businessVersion?: string;
    actions?: string[];
    ingestSlot?: 'ocr' | 'vision' | 'both';
    perActionBindings?: Record<string, ConnectorBindingsMap>;
  }): Promise<{ profileId: string; revisionsByAction: Record<string, number> }> {
    return this.bindActions(opts);
  }
}
