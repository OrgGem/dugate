/**
 * PC-R07 (backend) — the manifest's `parameterResolution` capability reaches
 * discovery, drives save validation, and stays inert for v1 manifests.
 *
 * The capability names ONE source per parameter property. Two failure modes are
 * covered here:
 *
 *  * **discovery** — the editor cannot save to the right source if the catalog
 *    does not tell it which source owns each property. `getBusinessFunctionCatalog`
 *    (admin-read, outside this packet's lease) projects the function descriptor
 *    without it, so `profile-groups.ts` reads the mapping from the registered
 *    manifest and attaches it.
 *  * **placement** — a value saved to the wrong source silently changes
 *    semantics: a `profileSettings` property in `requestDefaults` becomes
 *    client-overridable, and a `requestDefaults` property in the policy
 *    parameters is injected as request input. Both are refused with
 *    `422 INVALID_SCHEMA` before any row is written.
 *
 * A manifest without the capability is inert: nothing is inferred from the
 * intentional `inputSchema`/`profileSchema` overlap, and v1 saves behave exactly
 * as before.
 */
import type { PoolClient } from 'pg';
import type { Db } from '../src/db/db';
import {
  assertParameterSourcePlacement,
  readParameterResolutionByAction,
  saveProfileGroupV2,
  type ProfileGroupActor,
} from '../src/modules/profiles/profile-groups';
import { getBusinessFunctionCatalog } from '../src/modules/admin-read/business-functions';
import { ProfileGroupFunctionCatalogSchema } from '@du/contracts';
import { createProfileService } from '../src/modules/profiles/profiles';
import { HttpError } from '../src/http/errors';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const BUSINESS = 'pc-r07-core';
const VERSION = '2.0.0';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ACTOR: ProfileGroupActor = { actor: 'pc-r07', role: 'platform' };

/** One action WITH the capability and one WITHOUT, so inertness is provable. */
function manifest(): Record<string, unknown> {
  const base = {
    displayName: 'PC-R07 action',
    description: '',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', default: 'standard' }, enableReasoning: { type: 'boolean' } },
      additionalProperties: true,
    },
    outputSchema: { type: 'object' },
    profileSchema: {
      type: 'object',
      properties: { maxParallel: { type: 'integer' }, enableReasoning: { type: 'boolean' } },
      additionalProperties: false,
    },
    connectorSlots: [],
    artifactPolicy: { minFiles: 0, maxFiles: 4 },
    capabilities: { cancel: true, resume: true },
    defaultLimits: {},
  };
  return {
    contractVersion: '1',
    businessId: BUSINESS,
    version: VERSION,
    displayName: 'PC-R07 fixture',
    description: '',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    runtime: { wireVersion: '1', handlerKinds: ['mapped', 'plain', 'root'] },
    capabilities: { cancel: true, resume: true, parallel: false },
    actions: [
      {
        ...base,
        name: 'mapped',
        // The manifest capability carries the CANONICAL literals only;
        // `policySettings` is a discovery-wire alias and is handled separately.
        parameterResolution: {
          version: 2,
          fields: {
            mode: 'requestDefaults',
            enableReasoning: 'requestDefaults',
            maxParallel: 'profileSettings',
          },
          applyTopLevelDefaults: true,
        },
      },
      { ...base, name: 'plain' },
    ],
  };
}

function queryable(rowsBySql: Array<{ match: (sql: string) => boolean; rows: unknown[] }>): { query: any } {
  return {
    query: async (sql: string) => {
      const hit = rowsBySql.find((entry) => entry.match(sql));
      const rows = hit?.rows ?? [];
      return { rows, rowCount: rows.length };
    },
  };
}

const manifestQuery = (sql: string): boolean =>
  sql.includes('FROM business_versions') && sql.includes('manifest') && !sql.includes('JOIN business_catalog');

const catalogJoinQuery = (sql: string): boolean =>
  sql.includes('FROM business_versions') && sql.includes('JOIN business_catalog');

/* ------------------------------------------------------------------ */

describe('PC-R07 / discovery carries the declared source mapping', () => {
  it('reads the capability per action and normalizes the transitional alias', async () => {
    const byAction = await readParameterResolutionByAction(
      queryable([{ match: manifestQuery, rows: [{ manifest: manifest() }] }]) as never,
      BUSINESS,
      VERSION,
    );
    expect(byAction.size).toBe(1);
    expect(byAction.get('mapped')).toEqual({
      mode: 'requestDefaults',
      enableReasoning: 'requestDefaults',
      maxParallel: 'profileSettings',
    });
    // An action without the capability is simply absent: nothing is inferred.
    expect(byAction.has('plain')).toBe(false);
  });

  it('normalizes a stored `policySettings` alias to `profileSettings`', async () => {
    // A manifest row written before the vocabulary settled may still carry the
    // alias. It must be read as `profileSettings`, never surfaced verbatim.
    const legacyAlias = {
      actions: [{
        name: 'mapped',
        parameterResolution: { version: 2, fields: { maxParallel: 'policySettings' }, applyTopLevelDefaults: false },
      }],
    };
    const byAction = await readParameterResolutionByAction(
      queryable([{ match: manifestQuery, rows: [{ manifest: legacyAlias }] }]) as never,
      BUSINESS,
      VERSION,
    );
    expect(byAction.get('mapped')).toEqual({ maxParallel: 'profileSettings' });
  });

  it('a manifest without the capability yields no mapping at all (v1 inertness)', async () => {
    const v1 = manifest() as { actions: Array<Record<string, unknown>> };
    for (const action of v1.actions) delete action.parameterResolution;
    const byAction = await readParameterResolutionByAction(
      queryable([{ match: manifestQuery, rows: [{ manifest: v1 }] }]) as never,
      BUSINESS,
      VERSION,
    );
    expect(byAction.size).toBe(0);
  });

  it('ignores a capability declaring a version other than 2', async () => {
    const future = manifest() as { actions: Array<Record<string, unknown>> };
    (future.actions[0]!.parameterResolution as Record<string, unknown>).version = 3;
    const byAction = await readParameterResolutionByAction(
      queryable([{ match: manifestQuery, rows: [{ manifest: future }] }]) as never,
      BUSINESS,
      VERSION,
    );
    expect(byAction.size).toBe(0);
  });

  it('the registered catalog carries the mapping to the wire, and the unmapped action stays bare', async () => {
    // Through the REAL catalog builder (the projection lives in admin-read) and
    // the REAL response schema the v2 catalog route parses with, so this pins
    // the integration the editor depends on — not just our own manifest read.
    const db = queryable([{
      match: catalogJoinQuery,
      rows: [{
        business_id: BUSINESS,
        business_version: VERSION,
        manifest: manifest(),
        digest: DIGEST,
        business_enabled: true,
      }],
    }]) as never;
    const parsed = ProfileGroupFunctionCatalogSchema.parse(
      await getBusinessFunctionCatalog(db, BUSINESS, VERSION),
    );
    expect(parsed.functions.find((fn) => fn.action === 'mapped')?.parameterResolution).toEqual({
      mode: 'requestDefaults',
      enableReasoning: 'requestDefaults',
      maxParallel: 'profileSettings',
    });
    expect(parsed.functions.find((fn) => fn.action === 'plain')?.parameterResolution).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe('PC-R07 / misplaced values are refused', () => {
  const resolution = { mode: 'requestDefaults' as const, maxParallel: 'profileSettings' as const };

  it('accepts a value saved to its declared source', () => {
    expect(() => assertParameterSourcePlacement(
      'mapped',
      resolution,
      { maxParallel: { value: 2 } },
      { mode: { value: 'strict' } },
    )).not.toThrow();
  });

  it('refuses a requestDefaults property saved in the profile policy', () => {
    const error = (() => {
      try {
        assertParameterSourcePlacement('mapped', resolution, { mode: { value: 'strict' } }, undefined);
      } catch (err) {
        return err as HttpError;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(HttpError);
    expect({ status: error!.status, code: error!.code }).toEqual({ status: 422, code: 'INVALID_SCHEMA' });
    expect(error!.message).toContain("'mode' is declared as requestDefaults");
  });

  it('refuses a profileSettings property saved in the request defaults', () => {
    expect(() => assertParameterSourcePlacement(
      'mapped',
      resolution,
      undefined,
      { maxParallel: { value: 2 }, mode: { value: 'strict' } },
    )).toThrow(/maxParallel' is declared as profileSettings/);
  });

  it('refuses a request default the manifest does not map to that source', () => {
    expect(() => assertParameterSourcePlacement(
      'mapped',
      resolution,
      undefined,
      { unknown: { value: 1 }, mode: { value: 'strict' } },
    )).toThrow(/unknown' is not declared as a requestDefaults parameter/);
  });

  it('is inert when the manifest declares no capability (v1 behaviour preserved)', () => {
    // The overlap (`enableReasoning` in both schemas) and any legacy bag entry
    // must survive untouched: nothing is inferred without the capability.
    expect(() => assertParameterSourcePlacement(
      'plain',
      undefined,
      { mode: { value: 'strict' }, enableReasoning: { value: true } },
      { anything: { value: 1 }, maxParallel: { value: 4 } },
    )).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */

describe('PC-R07 / the save path refuses before writing', () => {
  /** A group that is already `GROUP_GRANT`, so the mutation is authority-valid. */
  function saveFake(): { db: Db; statements: string[] } {
    const statements: string[] = [];
    const rowsFor = (sql: string): unknown[] => {
      if (sql.includes('FROM profile_groups g') && sql.includes('JOIN profile_group_revisions')) {
        return [{
          group_id: GROUP,
          tenant_id: TENANT,
          root_name: 'pc-r07',
          active_revision: 1,
          auth_authority: 'GROUP_GRANT',
          access_version: 1,
          created_at: new Date('2026-10-01T00:00:00.000Z'),
          updated_at: new Date('2026-10-01T00:00:00.000Z'),
          revision: 1,
          name: 'pc-r07',
          api_key_id: null,
          revision_created_at: new Date('2026-10-01T00:00:00.000Z'),
        }];
      }
      if (catalogJoinQuery(sql)) {
        return [{
          business_id: BUSINESS,
          business_version: VERSION,
          manifest: manifest(),
          digest: DIGEST,
          business_enabled: true,
        }];
      }
      if (manifestQuery(sql)) return [{ manifest: manifest() }];
      if (sql.includes('FROM business_catalog') && sql.includes('FOR SHARE')) {
        return [{ business_id: BUSINESS, enabled: true }];
      }
      return [];
    };
    const query = async (sql: string) => {
      statements.push(sql);
      const rows = rowsFor(sql);
      return { rows, rowCount: rows.length };
    };
    return {
      db: { query, tx: async (work: (client: PoolClient) => Promise<unknown>) => work({ query } as unknown as PoolClient) } as unknown as Db,
      statements,
    };
  }

  const saveBody = (functions: Array<Record<string, unknown>>) => ({
    name: 'pc-r07',
    tenantId: TENANT,
    authMode: 'API_KEY' as const,
    expectedRevision: 1,
    businesses: [{ businessId: BUSINESS, businessVersion: VERSION, manifestDigest: DIGEST, functions }],
  });

  it('rejects a misplaced parameter and leaves no registry, revision or member write', async () => {
    const fake = saveFake();
    let thrown: unknown;
    try {
      await fake.db.tx((client) => saveProfileGroupV2(
        client,
        createProfileService(fake.db, { cryptoEnv: {} }),
        undefined,
        saveBody([{
          kind: 'workflow',
          functionId: 'mapped',
          action: 'mapped',
          workflowRevision: 1,
          // `mode` is declared as requestDefaults, so the policy bag is the wrong
          // source for it.
          policy: { parameters: { mode: { value: 'strict' } } },
          requestDefaults: {},
          connectorBindings: {},
        }]) as never,
        GROUP,
        ACTOR,
      ));
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof HttpError) || thrown.status !== 422) {
      throw new Error(`expected 422, got ${String((thrown as Error)?.message)} :: ${fake.statements.join(' | ')}`);
    }
    expect(thrown).toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });

    const writes = fake.statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql));
    expect(writes).toEqual([]);
  });

  it('accepts the same function when the value sits in its declared source', async () => {
    const fake = saveFake();
    // Reaching a *write* is the positive signal: validation passed. The fake has
    // no child/profile rows, so the save is expected to fail later — the point is
    // that it is not the parameter-placement refusal.
    let thrown: unknown;
    try {
      await fake.db.tx((client) => saveProfileGroupV2(
        client,
        createProfileService(fake.db, { cryptoEnv: {} }),
        undefined,
        saveBody([{
          kind: 'workflow',
          functionId: 'mapped',
          action: 'mapped',
          workflowRevision: 1,
          policy: { parameters: { maxParallel: { value: 2 } } },
          requestDefaults: { mode: { value: 'strict' } },
          connectorBindings: {},
        }]) as never,
        GROUP,
        ACTOR,
      ));
    } catch (error) {
      thrown = error;
    }
    const placementRefused = thrown instanceof HttpError
      && thrown.status === 422
      && /declared as|not declared/.test(thrown.message);
    expect(placementRefused).toBe(false);
    // ... and the placement check really ran for this function, so the silence
    // above is an accept, not a skipped code path.
    expect(fake.statements.some((sql) => manifestQuery(sql))).toBe(true);
  });
});
