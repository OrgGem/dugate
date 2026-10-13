import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createProfileRequestScope, findCurrentActiveProfileApiKey } from '../src/features/profiles/profile-request-scope.ts';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const businessScreen = source('../src/features/businesses/businesses-screen.tsx');
const businessCockpit = source('../src/features/businesses/business-detail-cockpit.tsx');
const profilesScreen = source('../src/features/profiles/profiles-screen.tsx');
const callbackEditor = source('../src/features/profiles/callback-policy-editor.tsx');
const redactionEditor = source('../src/features/profiles/request-redaction-editor.tsx');
const groupEditor = source('../src/features/profiles/profile-group-editor.tsx');
const profileCommandContract = source('../../../packages/contracts/src/profile-commands.ts');

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
