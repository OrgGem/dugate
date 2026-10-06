import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  apiKeyRefFromDetail,
  buildPublishBody,
  buildRollbackBody,
  buildUpsertBody,
} from '../../../apps/admin-web/src/features/profiles/command-bodies';
import { parseProfileDetail } from '../../../apps/admin-web/src/features/profiles/state';

/**
 * P745-UI-KEYS (Δ-UI-1) — the profile.* command bodies must carry the write
 * identity (`apiKey.apiKeyId`) that the T-API-01 detail read revealed: all
 * three commands are strict and require it, and the URL's
 * (business, version, name) cannot select a row on its own.
 *
 * Pure-logic assertions run against the REAL modules (no React render — the
 * mapping lives in `command-bodies.ts` precisely so it is testable without
 * mounting the client page). Static guards read the screen/client sources so
 * the wiring cannot silently drift back to the old signatures.
 *
 * CJS-safe on purpose: the admin-web Playwright config transpiles specs to CJS,
 * so `import.meta` is unavailable (`__dirname` is).
 */

const SPEC_DIR = __dirname;
const SCREEN_PATH = join(SPEC_DIR, '../../../apps/admin-web/src/features/profiles/profiles-screen.tsx');
const CLIENT_PATH = join(SPEC_DIR, '../../../apps/admin-web/src/lib/api/client.ts');

const KEY_ID = '123e4567-e89b-42d3-a456-426614174000';

/** Minimal typed detail fixture — the exact consumed surface of ProfileDetail. */
interface FakedDetail {
  businessId: string;
  businessVersion: string;
  profileName: string;
  revision: number;
  currentValues: Record<string, unknown>;
  policy: {
    enabled: boolean;
    parameters: Record<string, { value: unknown; isLocked?: boolean }>;
    jobPriority: 'LOW' | 'MEDIUM' | 'HIGH';
    allowedFileExtensions: string;
    fileUrlAuthConfigured: boolean;
    connectionsOverride: never[];
  };
  manifest: { actions: { name?: string }[] };
  capabilities: never[];
  apiKeyId?: string;
}

function makeDetail(apiKeyId?: string): FakedDetail {
  return {
    businessId: 'document-core',
    businessVersion: '1.0.0',
    profileName: 'extract.invoice',
    revision: 2,
    currentValues: { model: 'gemini-2.0' },
    policy: {
      enabled: true,
      parameters: { model: { value: 'gemini-2.0' } },
      jobPriority: 'MEDIUM',
      allowedFileExtensions: '.pdf',
      fileUrlAuthConfigured: false,
      connectionsOverride: [],
    },
    manifest: { actions: [{ name: 'extract' }] },
    capabilities: [],
    ...(apiKeyId !== undefined ? { apiKeyId } : {}),
  };
}

test.describe('P745-UI-KEYS — profile.* bodies carry the write identity from detail', () => {
  test('1. apiKeyRefFromDetail maps a real id and drops empty/absent ones', () => {
    expect(apiKeyRefFromDetail(makeDetail(KEY_ID))).toEqual({ apiKeyId: KEY_ID });
    expect(apiKeyRefFromDetail(makeDetail())).toBeUndefined();
    expect(apiKeyRefFromDetail({ apiKeyId: '' })).toBeUndefined();
    expect(apiKeyRefFromDetail(null)).toBeUndefined();
  });

  test('2. upsert body: CAS revision + policy + apiKey', () => {
    const body = buildUpsertBody(makeDetail(KEY_ID) as never, { enabled: true, parameters: {} });
    expect(body).toEqual({
      expectedRevision: 2,
      policy: { enabled: true, parameters: {} },
      apiKey: { apiKeyId: KEY_ID },
    });
  });

  test('3. publish body: expectedRevision + apiKey', () => {
    expect(buildPublishBody(makeDetail(KEY_ID) as never)).toEqual({
      expectedRevision: 2,
      apiKey: { apiKeyId: KEY_ID },
    });
  });

  test('4. rollback body: target + unconditional expectedRevision parity + apiKey', () => {
    expect(buildRollbackBody(makeDetail(KEY_ID) as never, 1)).toEqual({
      targetRevision: 1,
      expectedRevision: 2,
      apiKey: { apiKeyId: KEY_ID },
    });
    // revision 0 (unstored view) still carries expectedRevision — parity with
    // the pre-Δ call site, stale views answer 409 instead of moving silently.
    const zero = { ...makeDetail(KEY_ID), revision: 0 };
    expect(buildRollbackBody(zero as never, 1)).toEqual({
      targetRevision: 1,
      expectedRevision: 0,
      apiKey: { apiKeyId: KEY_ID },
    });
  });

  test('5. honest absence: no apiKeyId → the body has NO apiKey key (backend 422s)', () => {
    const upsert = buildUpsertBody(makeDetail() as never, {});
    const publish = buildPublishBody(makeDetail() as never);
    const rollback = buildRollbackBody(makeDetail() as never, 1);
    expect('apiKey' in upsert).toBe(false);
    expect('apiKey' in publish).toBe(false);
    expect('apiKey' in rollback).toBe(false);
  });

  test('6. parseProfileDetail carries apiKeyId through, never synthesizes it', () => {
    const wire = {
      ...makeDetail(),
      apiKeyId: KEY_ID,
    };
    const parsed = parseProfileDetail(wire);
    expect(parsed?.apiKeyId).toBe(KEY_ID);
    const without = parseProfileDetail(makeDetail());
    expect(without?.apiKeyId).toBeUndefined();
    const empty = parseProfileDetail({ ...makeDetail(), apiKeyId: '' });
    expect(empty?.apiKeyId).toBeUndefined();
  });

  test('7. static guard: the screen routes all three commands through the builders', () => {
    const src = readFileSync(SCREEN_PATH, 'utf8');
    expect(src).toContain('buildUpsertBody(detail, buildPolicy(row))');
    expect(src).toContain('buildPublishBody(detail)');
    expect(src).toContain('buildRollbackBody(detail, target)');
    // The old inline bodies must be gone (no raw detail.revision into publish/rollback).
    expect(src).not.toContain('{ expectedRevision: detail.revision, policy: buildPolicy(row) }');
  });

  test('8. static guard: the client forwards the built body verbatim', () => {
    const src = readFileSync(CLIENT_PATH, 'utf8');
    expect(src).toContain('body: ProfilePublishBody');
    expect(src).toContain('body: ProfileRollbackBody');
    // publish/rollback no longer rebuild a body from a bare expectedRevision.
    expect(src).not.toContain('body: { expectedRevision }');
    expect(src).not.toContain('body: { targetRevision,');
    const publishCall = src.slice(src.indexOf('/publish`,'), src.indexOf('/publish`,') + 200);
    expect(publishCall).toContain('{ body, csrf: true, idempotencyKey }');
  });
});
