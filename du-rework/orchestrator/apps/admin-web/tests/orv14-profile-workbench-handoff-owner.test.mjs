import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import ts from 'typescript';

const docsPath = '../src/features/docs/docs-screen.tsx';
const profilesPath = '../src/features/profiles/profiles-screen.tsx';
const [docs, profiles] = await Promise.all([
  readFile(new URL(docsPath, import.meta.url), 'utf8'),
  readFile(new URL(profilesPath, import.meta.url), 'utf8'),
]);

function extractFunction(source, name) {
  const file = ts.createSourceFile('docs-screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must exist`);
  return declaration.getText(file);
}

const parserSource = [
  extractFunction(docs, 'isRecord'),
  extractFunction(docs, 'recordValue'),
  extractFunction(docs, 'parseProfileWorkbenchHandoff'),
].join('\n');
const parsed = ts.transpileModule(parserSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});
const parseProfileWorkbenchHandoff = new Function(`${parsed.outputText}; return parseProfileWorkbenchHandoff;`)();

const valid = {
  profileWorkbenchHandoff: {
    handoffId: '5d8b64df-cb24-4a15-9a36-f8135b1d83ec',
    tenantId: '1a6ca8d7-d083-48e2-a9b3-7fa7d2898022',
    businessId: 'document-core',
    businessVersion: '1.1.0',
    profileName: 'extract-default',
    expectedRevision: 17,
  },
};

describe('Profile to Test Workbench handoff', () => {
  it('parses only bounded composite profile identity and a positive exact revision', () => {
    assert.deepEqual(parseProfileWorkbenchHandoff(valid), valid.profileWorkbenchHandoff);
    assert.equal(parseProfileWorkbenchHandoff({ ...valid, profileWorkbenchHandoff: { ...valid.profileWorkbenchHandoff, expectedRevision: 0 } }), null);
    assert.equal(parseProfileWorkbenchHandoff({ ...valid, profileWorkbenchHandoff: { ...valid.profileWorkbenchHandoff, tenantId: 'outside' } }), null);
    assert.equal(parseProfileWorkbenchHandoff({ profileWorkbenchHandoff: { ...valid.profileWorkbenchHandoff, profileName: 'x'.repeat(256) } }), null);
  });

  it('removes the missing legacy test endpoint and confirms before dropping local profile edits', () => {
    assert.doesNotMatch(profiles, /client\.testProfileEndpoint\(/);
    assert.doesNotMatch(profiles, /POST \/api\/v1\/admin\/profile-test-endpoint/);
    assert.match(profiles, /profileDraftHasChanges/);
    assert.match(profiles, /Discard local edits and continue/);
    assert.match(profiles, /navigate\('\/docs', \{ state: \{ profileWorkbenchHandoff: handoff \} \}\)/);
    assert.match(profiles, /detail\.businessId[\s\S]*detail\.businessVersion[\s\S]*detail\.profileName[\s\S]*expectedRevision: detail\.revision/);
  });

  it('rechecks active tenant and exact current server revision before selecting the handoff', () => {
    assert.match(docs, /handoff\.tenantId !== tenantId/);
    assert.match(docs, /client\.getProfile\(handoff\.businessId, handoff\.businessVersion, handoff\.profileName\)/);
    assert.match(docs, /detail\.revision !== handoff\.expectedRevision/);
    assert.match(docs, /if \(!detail\.policy\.enabled\)/);
    assert.match(docs, /setSelectedProfileValue\(profile\.key\)/);
    assert.match(profiles, /This is the selected saved Profile revision/);
  });
});
