import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const docsScreen = readFileSync(new URL('../src/features/docs/docs-screen.tsx', import.meta.url), 'utf8');
const profilesScreen = readFileSync(new URL('../src/features/profiles/profiles-screen.tsx', import.meta.url), 'utf8');

describe('ORV14 Admin Workbench owner source checks', () => {
  it('builds ordinary action controls from the admitted manifest and assigned endpoint schemas', () => {
    assert.match(docsScreen, /function actionInputSchemas\(rawDetail: unknown, actions: readonly string\[\]\)/);
    assert.match(docsScreen, /inputSchemas: \{ \[row\.assigned\.action\]: safeSchema\(row\.assigned\.inputSchema\) \}/);
    assert.match(docsScreen, /type="checkbox"/);
    assert.match(docsScreen, /fieldType === 'enum'/);
    assert.match(docsScreen, /type="number"/);
    assert.match(docsScreen, /type="text"/);
    assert.match(docsScreen, /Advanced parameters JSON/);
  });

  it('shows locked values as managed and strips them from the request payload', () => {
    assert.match(docsScreen, /Other locked Profile values/);
    assert.match(docsScreen, /Managed by this Profile/);
    assert.match(docsScreen, /if \(secretLikeField\(key\) \|\| lockedKeySet\.has\(key\)\) \{ delete parameters\[key\]; continue; \}/);
    assert.match(docsScreen, /Locked fields were omitted from the request/);
  });

  it('keeps the saved Profile endpoint selector through Workbench selection and submission', () => {
    assert.match(docsScreen, /endpointSlug: item\.endpointSlug,/);
    assert.match(docsScreen, /row\.endpointSlug !== undefined && detail\.endpointSlug !== undefined && row\.endpointSlug !== detail\.endpointSlug/);
    assert.match(docsScreen, /endpointSlug: selection\.profile\.endpointSlug \?\? null/);
  });

  it('requires placeholder review and offers explicit local-draft acceptance and Profile handoff', () => {
    assert.match(docsScreen, /Prompt diff/);
    assert.match(docsScreen, /Accept proposal to local draft/);
    assert.match(docsScreen, /Open Profile editor with this draft/);
    assert.match(profilesScreen, /revision !== proposal\.expectedRevision/);
    assert.match(profilesScreen, /Wizard proposal loaded into the local Profile prompt draft/);
    assert.match(profilesScreen, /Wizard proposal loaded into the local assigned-Profile draft/);
  });
});
