import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  actionFromEndpointSlug,
  firstSuccessfulProfileTarget,
  newProfileAction,
  normalizeProfileTarget,
  profileTargetAfterSave,
  resolveProfileIdentityFromCatalog,
  resolveProfileActionFromCatalog,
} from '../src/features/profiles/profile-identity.ts';

const baseProfile = {
  manifest: { actions: [{ name: 'analyze' }, { action: 'extract' }] },
};

describe('profile resource and action identity', () => {
  it('derives a manifest action from a selected endpoint without using the profile resource name', () => {
    assert.equal(actionFromEndpointSlug('analyze:classify'), 'analyze');
    assert.equal(newProfileAction(baseProfile, 'analyze:classify'), 'analyze');
    assert.equal(newProfileAction(baseProfile, ''), 'analyze');
    assert.equal(actionFromEndpointSlug('  '), null);
  });

  it('resolves an existing name only from the exact tenant, business, version and catalog action', () => {
    const expected = {
      tenantId: 'tenant-sentinel-legacy',
      businessId: 'document-core',
      businessVersion: '1.1.0',
      profileName: 'codex-ui-check-20261014',
    };
    const unrelated = {
      ...expected,
      tenantId: 'another-tenant',
      boundActions: ['extract'],
    };
    const exact = { ...expected, boundActions: ['analyze'] };
    assert.deepEqual(resolveProfileActionFromCatalog([unrelated, exact], expected), {
      kind: 'resolved',
      action: 'analyze',
    });
    assert.deepEqual(resolveProfileActionFromCatalog([], expected), { kind: 'missing' });
  });

  it('fails closed when one resource name is bound to multiple or unknown actions', () => {
    const expected = { tenantId: 'tenant-a', businessId: 'document-core', businessVersion: '1.1.0', profileName: 'named-profile' };
    assert.deepEqual(resolveProfileActionFromCatalog([
      { ...expected, boundActions: ['analyze'] },
      { ...expected, boundActions: ['extract'] },
    ], expected), { kind: 'ambiguous' });
    assert.deepEqual(resolveProfileActionFromCatalog([
      { ...expected, boundActions: [] },
    ], expected), { kind: 'ambiguous' });
  });

  it('selects one catalog profile id and rejects duplicate same-name resources even when actions match', () => {
    const expected = { tenantId: 'tenant-a', businessId: 'document-core', businessVersion: '1.1.0', profileName: 'shared-name' };
    const selected = {
      ...expected,
      profileId: '11111111-1111-4111-8111-111111111111',
      boundActions: ['analyze'],
      action: 'analyze',
      endpointSlug: null,
    };
    assert.deepEqual(resolveProfileIdentityFromCatalog([selected], expected), {
      kind: 'resolved',
      profileId: selected.profileId,
      action: 'analyze',
      endpointSlug: null,
    });
    assert.deepEqual(resolveProfileIdentityFromCatalog([
      selected,
      { ...selected, profileId: '22222222-2222-4222-8222-222222222222' },
    ], expected), { kind: 'ambiguous' });
  });

  it('keeps generic endpoint null distinct from metadata omitted by an older catalog response', () => {
    const expected = { tenantId: 'tenant-a', businessId: 'document-core', businessVersion: '1.1.0', profileName: 'named-profile' };
    const row = { ...expected, profileId: '11111111-1111-4111-8111-111111111111', action: 'analyze', boundActions: ['analyze'] };
    assert.equal(resolveProfileIdentityFromCatalog([{ ...row, endpointSlug: null }], expected).endpointSlug, null);
    assert.equal(resolveProfileIdentityFromCatalog([row], expected).endpointSlug, undefined);
  });

  it('refreshes a saved row with its named resource, changed action, generic endpoint and mutation profile id', () => {
    const target = profileTargetAfterSave({
      businessId: 'document-core', businessVersion: '1.1.0', profileName: 'draft-name', action: 'ingest',
      profileId: '22222222-2222-4222-8222-222222222222',
    }, { profileName: 'named-profile', action: 'analyze', endpointSlug: '' }, '33333333-3333-4333-8333-333333333333');
    assert.deepEqual(target, {
      businessId: 'document-core', businessVersion: '1.1.0', profileName: 'named-profile', action: 'analyze',
      endpointSlug: null, profileId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('uses the first successful row with a refresh identity after Save All', () => {
    const first = { businessId: 'doc', businessVersion: '1.0.0', profileName: 'first', action: 'analyze', endpointSlug: null, profileId: '11111111-1111-4111-8111-111111111111' };
    const second = { ...first, profileName: 'second', profileId: '22222222-2222-4222-8222-222222222222' };
    assert.deepEqual(firstSuccessfulProfileTarget([
      { ok: false, savedTarget: first },
      { ok: true, savedTarget: first },
      { ok: true, savedTarget: second },
    ]), first);
    assert.equal(firstSuccessfulProfileTarget([{ ok: true }]), null);
  });

  it('normalizes latest to the concrete detail version before stored-profile lookup and identity capture', async () => {
    const target = { businessId: 'document-core', businessVersion: 'latest', profileName: 'codex-ui-check-20261014' };
    const detail = { businessId: 'document-core', businessVersion: '1.1.0', profileName: target.profileName };
    assert.deepEqual(normalizeProfileTarget(target, detail), {
      businessId: 'document-core', businessVersion: '1.1.0', profileName: target.profileName,
    });

    const source = await readFile(new URL('../src/features/profiles/profiles-screen.tsx', import.meta.url), 'utf8');
    assert.equal((source.match(/normalizeProfileTarget\(/g) ?? []).length, 2, 'direct load and existing/new create both normalize the parsed detail');
    assert.equal((source.match(/lookupStoredProfileIdentity/g) ?? []).length, 3, 'direct load and existing create resolve against the concrete version catalog');
  });

  it('keeps the catalog Open and save/refresh paths on the named resource plus resolved action', async () => {
    const source = await readFile(new URL('../src/features/profiles/profiles-screen.tsx', import.meta.url), 'utf8');
    assert.match(source, /profileName: row\.profileName,[\s\S]*?\.\.\.\(row\.profileId \? \{ profileId: row\.profileId \} : \{\}\),[\s\S]*?\.\.\.\(row\.action \? \{ action: row\.action \} : row\.boundActions\.length === 1 \? \{ action: row\.boundActions\[0\] \} : \{\}\),[\s\S]*?row\.endpointSlug/);
    assert.match(source, /const profileKey = row\.profileName\.trim\(\) \|\| target\.profileName;/);
    assert.match(source, /buildUpsertBody\(effectiveDetail, buildPolicy\(row\), action\)/);
    assert.match(source, /client\.getProfile\(target\.businessId, target\.businessVersion, targetName, \{[\s\S]*?profileId: target\.profileId/);
    assert.match(source, /client\.getProfile\(resolvedTarget\.businessId, resolvedTarget\.businessVersion, resolvedName, \{[\s\S]*?profileId: resolution\.profileId/);
    assert.match(source, /client\.getProfile\(resolvedTarget\.businessId, resolvedTarget\.businessVersion, resolvedTarget\.profileName, \{[\s\S]*?profileId: resolution\.profileId/);
    assert.match(source, /profileId: resolvedProfileId,[\s\S]*?action,[\s\S]*?endpointSlug: selectedProfileEndpoint/);
    assert.match(source, /PROFILE_IDENTITY_MISMATCH/);
    assert.match(source, /profileTargetAfterSave\(target,[\s\S]*?response\.data\.profileId\)/);
    assert.match(source, /firstSuccessfulProfileTarget\(settled\.flatMap/);
    assert.match(source, /load\(savedTarget\.profileName, savedTarget, busyOperation\)/);
    assert.match(source, /PROFILE_ENDPOINT_UNRESOLVED/);
  });
});
