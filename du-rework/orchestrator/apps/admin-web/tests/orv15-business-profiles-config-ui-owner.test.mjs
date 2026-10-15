import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { createProfileRequestScope, findCurrentActiveProfileApiKey } from '../src/features/profiles/profile-request-scope.ts';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const businessScreen = source('../src/features/businesses/businesses-screen.tsx');
const businessCockpit = source('../src/features/businesses/business-detail-cockpit.tsx');
const profilesScreen = source('../src/features/profiles/profiles-screen.tsx');
const callbackEditor = source('../src/features/profiles/callback-policy-editor.tsx');
const redactionEditor = source('../src/features/profiles/request-redaction-editor.tsx');
const groupEditor = source('../src/features/profiles/profile-group-editor.tsx');
const profileCommandContract = source('../../../packages/contracts/src/profile-commands.ts');

function extractFunction(sourceText, name) {
  const file = ts.createSourceFile('profiles-screen.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must exist`);
  return declaration.getText(file);
}

const normalizedPinChangeSource = [
  extractFunction(profilesScreen, 'normalizedConnectorBindingEntries'),
  extractFunction(profilesScreen, 'connectorBindingsChanged'),
].join('\n');
const normalizedPinChangeCompiled = ts.transpileModule(normalizedPinChangeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});
const connectorBindingsChanged = new Function(`${normalizedPinChangeCompiled.outputText}; return connectorBindingsChanged;`)();

describe('ORV15 Business and Profile configuration UI owner checks', () => {
  it('keeps business detail in three tabs and nests worker inventory under version groups', () => {
    const tabs = [...businessCockpit.matchAll(/<TabsTab value="([^"]+)">([^<]+)<\/TabsTab>/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(tabs, [
      ['versions', 'Versions &amp; workers'],
      ['profiles', 'Profiles'],
      ['workflows', 'Workflow schemas'],
    ]);
    assert.match(businessCockpit, /versions\.data\.rows\.map\(\(version\).*loadedWorkers\.filter\(\(worker\) => worker\.businessVersion === version\.version\)/s);
    assert.match(businessCockpit, /group\.rows\.map\(\(worker\)/);
    assert.match(businessCockpit, /Business intake/);
    assert.match(businessCockpit, /acceptedTaskCountScope/);
    assert.match(businessCockpit, /workflowProfile\.length === 0 && profileRows\.length > 0/);
    assert.match(businessCockpit, /selected from another page/);
    assert.match(businessCockpit, /setProfileIndex\(index\);[\s\S]*if \(index > profileIndex\) setProfileCursors/);
    assert.match(businessScreen, /client\.listBusinesses\(\{ limit: '20'/);
    assert.match(businessScreen, /<TablePagination[\s\S]*onPreviousPage=\{goPrevious\}[\s\S]*onNextPage=\{goNext\}/);
    assert.match(businessScreen, /<TableContainer maxHeight=\{440\}[^>]*aria-label=/);
    assert.ok(
      businessScreen.indexOf('const generation = await load(cursor, preserveRows, nextIndex);') < businessScreen.indexOf('setPageIndex(nextIndex);'),
      'business registry page index is committed only after the requested page loads',
    );
    assert.match(businessScreen, /const retry = failedPageRequest \?\? \{ index: pageIndex, cursor: cursorHistory\[pageIndex\] \};/);
  });

  it('pages the profile catalog and role-sensitive assigned endpoints with their own server cursors', () => {
    assert.match(profilesScreen, /tenantId: globalTenantId, limit: '50'/);
    assert.match(profilesScreen, /limit: String\(profileListPage\.limit\),\s*cursor,/);
    assert.match(profilesScreen, /onPreviousPage=\{\(\) => void loadMoreProfiles\('previous'\)\}/);
    assert.match(profilesScreen, /onNextPage=\{\(\) => void loadMoreProfiles\('next'\)\}/);
    assert.match(profilesScreen, /generation === profileListRequestGeneration\.current[\s\S]*profileListScopeRef\.current === requestScope/);
    assert.match(profilesScreen, /function refreshProfileCatalog\(\): void[\s\S]*profileListRequestGeneration\.current \+= 1[\s\S]*setProfileListPageIndex\(0\)/);
    assert.match(profilesScreen, /listAssignedProfileEndpoints\(\{ query: queryValue\.trim\(\) \|\| undefined, cursor: next \?\? undefined, limit: 50 \}\)/);
    assert.match(profilesScreen, /assignedScopeRef\.current === requestTenantId/);
    assert.match(profilesScreen, /navigateAssignedPage\('first'\)/);
    assert.match(profilesScreen, /assignedPageCursors\[targetIndex\]/);
    assert.match(profilesScreen, /setPage\(result\);\s*setAssignedPageIndex\(targetIndex\)/);
    assert.doesNotMatch(profilesScreen, /items: \[\.\.\.current\.items, \.\.\.result\.items\]/);
    assert.match(profilesScreen, /aria-label="Current server page of assigned endpoints"[^>]*tabIndex=\{0\}[^>]*max-h-/);
    assert.match(profilesScreen, /sm:grid-cols-\[minmax\(0,1fr\)_auto\] sm:items-start[\s\S]*sm:mt-\[1\.375rem\]/);
  });

  it('keeps profile mutation actions outside mounted editor panels and leaves Groups platform-only', () => {
    const actionCard = profilesScreen.indexOf('Save Profile');
    const editorTabs = profilesScreen.indexOf('<TabsRoot defaultValue="parameters"');
    assert.ok(actionCard >= 0 && editorTabs > actionCard, 'Save, Publish, and Rollback remain visible before the editor tabs');
    for (const panel of ['parameters', 'workflows', 'api-keys', 'callback', 'auth-prompts', 'snapshot']) {
      assert.match(profilesScreen, new RegExp(`<TabsPanel value="${panel}" keepMounted`));
    }
    assert.match(profilesScreen, /access\.session\.principal\.kind === 'platform' \? <TabsTab value="groups">Groups<\/TabsTab>/);
    assert.match(profilesScreen, /<TabsPanel value="groups" keepMounted>/);
    assert.match(profilesScreen, /<ProfileApiKeysPanel businessId=\{loadedAs\.businessId\}/);
    assert.match(profilesScreen, /<RequestRedactionEditor rules=\{row\.requestRedaction\}/);
    assert.match(profilesScreen, /<CallbackPolicyEditor idPrefix=/);
  });

  it('requires the selected active key from the current tenant for every Profile mutation', () => {
    assert.match(profilesScreen, /setApiKeys\(result\.data\.items\.filter\(\(key\) => key\.tenantId === globalTenantId\)\)/, 'keep tenant-owned revoked keys in inventory for ownership checks');
    assert.match(profilesScreen, /findCurrentActiveProfileApiKey\(apiKeys, detailApiKeyId \?\? '', globalTenantId\)/);
    assert.doesNotMatch(profilesScreen, /activeKeys\[0\]/, 'loading keys must not silently choose an unrelated key');
    assert.doesNotMatch(profilesScreen, /detail\.apiKeyId \|\| selectedApiKeyId/, 'a stale detail key must not override the visible selection');
    assert.match(profilesScreen, /const selectedActiveApiKey = findCurrentActiveProfileApiKey\(apiKeys, selectedApiKeyId, globalTenantId\)/);
    assert.match(profilesScreen, /<option value="">\{activeApiKeys\.length === 0 \? 'No active key in tenant' : 'Select an active API key'\}<\/option>/, 'the empty key selection must be explicit');
    assert.match(profileCommandContract, /apiKey: ApiKeyRefSchema/, 'Profile commands require a key reference');

    const saveRowStart = profilesScreen.indexOf('async function saveRow');
    const saveOneStart = profilesScreen.indexOf('async function saveOne', saveRowStart);
    const saveRow = profilesScreen.slice(saveRowStart, saveOneStart);
    assert.ok(saveRow.indexOf('if (!writeApiKey)') < saveRow.indexOf('client.upsertProfile('), 'invalid or stale key returns before the upsert call');
    assert.match(saveRow, /apiKeyId: writeApiKey\.id/);
    assert.match(saveRow, /target\.tenantId !== globalTenantId[\s\S]*profileTenantScopeProblem/);
    assert.match(profilesScreen, /findCurrentActiveProfileApiKey\(apiKeys, selectedApiKeyId, mutationToken\.tenantId\)[\s\S]*client\.publishProfile/);
    assert.match(profilesScreen, /findCurrentActiveProfileApiKey\(apiKeys, selectedApiKeyId, mutationToken\.tenantId\)[\s\S]*client\.rollbackProfile/);
    assert.match(profilesScreen, /disabled=\{busy \|\| loading \|\| !canMutateLoadedProfile\}[\s\S]*Save Profile/);
    assert.match(profilesScreen, /disabled=\{!policyShipped \|\| busy \|\| loading \|\| !canMutateLoadedProfile\}/);
    assert.match(profilesScreen, /<Link[^>]*to="\/api-keys">Manage API keys<\/Link>/);
  });

  it('loads saved connector pins and saves the complete validated map with every Profile revision', () => {
    assert.match(profilesScreen, /function initialBindingsFromProfile\(profile: ProfileDetail \| null\): InitialBinding\[\][\s\S]*Object\.entries\(profile\.connectorBindings\)/);
    const loadStart = profilesScreen.indexOf('async function load(');
    const createStart = profilesScreen.indexOf('async function createProfile()', loadStart);
    const load = profilesScreen.slice(loadStart, createStart);
    assert.match(load, /setInitialBindings\(initialBindingsFromProfile\(parsed\)\)/, 'saved connector pins hydrate the editor after a successful read');
    const createEnd = profilesScreen.indexOf('async function setWorkflowEnabled', createStart);
    const createProfile = profilesScreen.slice(createStart, createEnd);
    assert.match(createProfile, /setInitialBindings\(initialBindingsFromProfile\(parsed\)\)/, 'new-profile initialization clears stale connector pins from the prior editor');

    const saveRowStart = profilesScreen.indexOf('async function saveRow');
    const saveOneStart = profilesScreen.indexOf('async function saveOne', saveRowStart);
    const saveRow = profilesScreen.slice(saveRowStart, saveOneStart);
    assert.match(saveRow, /initialBindings\.length > 32[\s\S]*Number\.isSafeInteger\(binding\.revision\)[\s\S]*new Set\(connectorSlots\)\.size !== initialBindings\.length/);
    assert.match(saveRow, /connectorBindings: Object\.fromEntries\(initialBindings\.map\(/, 'every save sends the complete slot-to-typed-revision map');
    assert.doesNotMatch(saveRow, /detail\.revision === 0 && initialBindings/, 'existing profiles use the same binding write path as new profiles');
    assert.match(saveRow, /expectedRevision: detail\.revision|buildUpsertBody\(effectiveDetail, buildPolicy\(row\), action\)/, 'the upsert retains its current revision CAS');
    assert.match(saveRow, /const writeApiKey = findCurrentActiveProfileApiKey\(apiKeys, selectedApiKeyId, currentScope\.tenantId\)[\s\S]*if \(!writeApiKey\)[\s\S]*client\.upsertProfile\(/, 'the saved pins still require the selected active key');
  });

  it('treats pin-only edits as unsaved while ignoring order changes and invalid placeholders', () => {
    const saved = {
      reasoning: { connectorId: 'local-openai-mock', revision: 4 },
      embeddings: { connectorId: 'local-embedding-mock', revision: 2 },
    };
    const savedRows = Object.entries(saved).map(([slot, pin]) => ({ slot, ...pin }));
    assert.equal(connectorBindingsChanged([...savedRows].reverse(), saved), false, 'row order does not change the normalized pin map');
    assert.equal(connectorBindingsChanged([...savedRows, { slot: '', connectorId: '', revision: 0 }], saved), false, 'an empty invalid placeholder does not trigger a false-positive discard prompt');
    assert.equal(connectorBindingsChanged([
      ...savedRows.filter((row) => row.slot !== 'reasoning'),
      { slot: 'reasoning', connectorId: 'local-openai-mock', revision: 5 },
    ], saved), true, 'changing only a saved Connector revision is a dirty Profile draft');
    assert.match(profilesScreen, /connectorBindingsChanged\(initialBindings, detail\.connectorBindings\)/);
    assert.match(profilesScreen, /if \(profileDraftHasChanges\)\s*\{\s*setWorkbenchConfirmOpen\(true\)/, 'pin-only edits trigger the existing Workbench discard confirmation');
  });

  it('ignores controlled Profile reads from a prior tenant, including an A-to-B-to-A switch', async () => {
    const scope = createProfileRequestScope('tenant-a');
    const deferred = () => {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      return { promise, resolve };
    };
    const startRead = () => {
      const token = scope.beginRequest();
      const response = deferred();
      return {
        result: response.promise.then((value) => scope.isRequestCurrent(token) ? value : null),
        resolve: response.resolve,
      };
    };

    const firstA = startRead();
    scope.updateTenant('tenant-b');
    const readB = startRead();
    scope.updateTenant('tenant-a');
    const latestA = startRead();

    firstA.resolve({ profileName: 'stale-a' });
    readB.resolve({ profileName: 'stale-b' });
    latestA.resolve({ profileName: 'current-a' });
    assert.equal(await firstA.result, null);
    assert.equal(await readB.result, null);
    assert.deepEqual(await latestA.result, { profileName: 'current-a' });
    assert.match(profilesScreen, /profileRequestScope\.current\.updateTenant\(globalTenantId\)/);
    assert.match(profilesScreen, /const requestToken = profileRequestScope\.current\.beginRequest\(\)/);
    assert.match(profilesScreen, /profileRequestScope\.current\.isRequestCurrent\(requestToken\)/);

    const pendingMutation = scope.beginRequest();
    scope.beginRequest();
    assert.equal(scope.isRequestCurrent(pendingMutation), false, 'a newer editor request suppresses the older mutation completion');
    const mutationForReload = scope.beginRequest();
    assert.equal(scope.isRequestCurrent(mutationForReload), true);
    scope.beginRequest();
    const reloadToken = scope.captureRequest();
    assert.equal(scope.isRequestCurrent(reloadToken), true, 'a mutation may track its own post-write reload');
    scope.invalidateRequests();
    assert.equal(scope.isRequestCurrent(reloadToken), false, 'unmount invalidates pending reload notices');
    assert.match(profilesScreen, /const mutationToken = profileRequestScope\.current\.beginRequest\(\)/);
    assert.match(profilesScreen, /const refreshToken = profileRequestScope\.current\.captureRequest\(\)/);
  });

  it('rejects revoked or different-tenant stored keys and writes only with an explicitly selected active key', () => {
    const keys = [
      { id: 'old-a', tenantId: 'tenant-a', status: 'REVOKED' },
      { id: 'active-b', tenantId: 'tenant-b', status: 'ACTIVE' },
    ];
    assert.equal(findCurrentActiveProfileApiKey(keys, 'old-a', 'tenant-a'), undefined);
    assert.equal(findCurrentActiveProfileApiKey(keys, 'old-a', 'tenant-b'), undefined);
    assert.equal(findCurrentActiveProfileApiKey(keys, 'active-b', 'tenant-b')?.id, 'active-b');
    assert.match(profilesScreen, /if \(!writeApiKey\)[\s\S]*return \{[\s\S]*problem: profileWriteProblem/);
  });

  it('uses responsive control rows instead of bottom-aligning form actions with field messages', () => {
    for (const content of [businessScreen, businessCockpit, profilesScreen, callbackEditor, redactionEditor, groupEditor]) {
      assert.doesNotMatch(content, /items-end/);
    }
    assert.match(callbackEditor, /grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-\[minmax\(10rem,12rem\)_minmax\(12rem,1fr\)_auto\]/);
    assert.match(redactionEditor, /grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-\[minmax\(0,1fr\)_minmax\(10rem,14rem\)_auto\]/);
    assert.match(groupEditor, /sm:mt-\[1\.45rem\]/);
    assert.match(profilesScreen, /sm:mt-\[1\.375rem\]/);
  });
});
