import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parseCurlImport, summarizeCurlImport } from '../src/features/connectors/curl-import.ts';
import { isTenantUuid } from '../../../packages/contracts/src/tenant-identity.ts';
import ts from 'typescript';

const stateSource = await readFile(new URL('../src/features/connectors/state.ts', import.meta.url), 'utf8');
const screenSource = await readFile(new URL('../src/features/connectors/connectors-screen.tsx', import.meta.url), 'utf8');
const paritySource = await readFile(new URL('../src/features/connectors/parity-connector-editor.tsx', import.meta.url), 'utf8');
const compiledState = ts.transpileModule(stateSource, {
  fileName: 'connectors-state.ts',
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
  reportDiagnostics: true,
});
const compileErrors = (compiledState.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
assert.deepEqual(compileErrors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
const curlImportUrl = new URL('../src/features/connectors/curl-import.ts', import.meta.url).href;
const stateModuleSource = compiledState.outputText.replace(
  /from (['"])\.\/curl-import\1/g,
  `from '${curlImportUrl}'`,
);
assert.notEqual(stateModuleSource, compiledState.outputText, 'state module must resolve its curl helper import');
const stateModuleUrl = `data:text/javascript;base64,${Buffer.from(stateModuleSource, 'utf8').toString('base64')}`;
const connectorState = await import(stateModuleUrl);
const {
  buildConnectorUpsertParams,
  connectorActionGating,
  connectorCredentialActionGating,
  connectorConfigFromDraft,
  parseConnectorCapabilities,
  summarizeConnectorConfig,
} = connectorState;

function actionFlags(gating) {
  return {
    upsert: gating.upsert,
    activate: gating.activate,
    disable: gating.disable,
    retire: gating.retire,
    test: gating.test,
    rotate: gating.rotate,
  };
}

function importCurlWithSecrets() {
  const bearerToken = 'bearer-token-secret-9876';
  const headerToken = 'header-token-secret-5432';
  const formPassword = 'form-password-secret-1111';
  const command = [
    'curl --request POST',
    '--url https://api.example.test/v1/import',
    `--header 'Authorization: Bearer ${bearerToken}'`,
    "--header 'X-Trace-Id: trace-17'",
    `--header 'X-Custom-Token: ${headerToken}'`,
    "--form 'username=alice'",
    `--form 'password=${formPassword}'`,
    "--form 'document=@/private/customer-file.pdf'",
  ].join(' ');
  return { result: parseCurlImport(command), bearerToken, headerToken, formPassword };
}

describe('Connectors state honesty', () => {
  it('accepts canonical PostgreSQL UUID syntax without imposing RFC version bits', () => {
    assert.equal(isTenantUuid('00000000-0000-0000-0000-000000000001'), true);
    assert.equal(isTenantUuid('not-a-tenant'), false);
  });

  it('fails closed when the capability advertisement is absent or unreadable', () => {
    assert.equal(parseConnectorCapabilities(null), null);
    assert.equal(parseConnectorCapabilities({ management: true, test: true }), null);
    assert.equal(parseConnectorCapabilities({
      management: true,
      credentialWorkflow: false,
      test: true,
      knownConnectorIds: ['connector-a'],
      unexpected: true,
    }), null);

    const gating = connectorActionGating(null);
    assert.deepEqual(actionFlags(gating), {
      upsert: false,
      activate: false,
      disable: false,
      retire: false,
      test: false,
      rotate: false,
    });
    assert.match(gating.reason, /advertisement is unavailable/);
  });

  it('enables only the actions advertised by the deployment', () => {
    const readOnly = parseConnectorCapabilities({
      management: false,
      credentialWorkflow: true,
      test: true,
      knownConnectorIds: ['connector-a'],
    });
    assert.ok(readOnly);
    const readOnlyGating = connectorActionGating(readOnly);
    assert.deepEqual(actionFlags(readOnlyGating), {
      upsert: false,
      activate: false,
      disable: false,
      retire: false,
      test: true,
      rotate: true,
    });
    assert.match(readOnlyGating.reason, /management:false/);

    const managed = parseConnectorCapabilities({
      management: true,
      credentialWorkflow: false,
      typedCredentialStorage: true,
      secretCatalogImport: true,
      test: false,
      knownConnectorIds: [],
    });
    assert.ok(managed);
    assert.deepEqual(actionFlags(connectorActionGating(managed)), {
      upsert: true,
      activate: true,
      disable: true,
      retire: true,
      test: false,
      rotate: false,
    });
    assert.deepEqual(connectorCredentialActionGating(managed, true), {
      replaceClear: true,
      secretCatalogImport: true,
    });
    assert.deepEqual(connectorCredentialActionGating(readOnly, true), {
      replaceClear: false,
      secretCatalogImport: false,
    });
    assert.equal(parseConnectorCapabilities({
      management: true,
      credentialWorkflow: false,
      typedCredentialStorage: 'true',
      secretCatalogImport: 'true',
      test: false,
      knownConnectorIds: [],
    }), null);
  });

  it('summarizes connector configuration as sorted keys and header names only', () => {
    const config = {
      endpointUrl: 'https://private.example.test/endpoint',
      auth: { type: 'BEARER', value: 'config-auth-secret-4433' },
      headers: [
        { name: 'X-Trace-Id', value: 'trace-value-17' },
        { name: 'Authorization', value: 'authorization-secret-2244' },
        { name: 'X-Api-Key', value: '[REDACTED]' },
        { name: '', value: 'ignored-header-value' },
        null,
      ],
      nested: { token: 'nested-secret-3355' },
    };

    const summary = summarizeConnectorConfig(config);
    assert.deepEqual(summary, {
      keys: ['auth', 'endpointUrl', 'headers', 'nested'],
      headerNames: ['X-Trace-Id'],
      redactedHeaderNames: ['Authorization', 'X-Api-Key'],
    });
    const serialized = JSON.stringify(summary);
    for (const secret of [
      'private.example.test',
      'config-auth-secret-4433',
      'trace-value-17',
      'authorization-secret-2244',
      'nested-secret-3355',
    ]) assert.ok(!serialized.includes(secret), `summary must not expose ${secret}`);
  });

  it('masks imported curl secrets in the preview while retaining only safe values', () => {
    const { result, bearerToken, headerToken, formPassword } = importCurlWithSecrets();
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.draft.auth.secretValue, bearerToken);
    const summary = summarizeCurlImport(result.draft);
    assert.equal(summary.auth.preview, '****9876');
    assert.deepEqual(summary.headers.find((header) => header.name === 'X-Custom-Token'), {
      name: 'X-Custom-Token',
      secret: true,
      valueChars: headerToken.length,
      preview: '****5432',
    });
    assert.deepEqual(summary.formFields.find((field) => field.name === 'password'), {
      name: 'password',
      secret: true,
      isFile: false,
      valueChars: formPassword.length,
      preview: '****1111',
    });
    assert.equal(summary.formFields.find((field) => field.name === 'document')?.preview, '@customer-file.pdf');

    const renderedSummary = JSON.stringify(summary);
    for (const sensitive of [bearerToken, headerToken, formPassword, '/private/customer-file.pdf']) {
      assert.ok(!renderedSummary.includes(sensitive), `curl preview must not expose ${sensitive}`);
    }
    assert.ok(renderedSummary.includes('trace-17') === false);
    assert.ok(summary.headers.some((header) => header.name === 'X-Trace-Id' && header.preview === 'set (8 chars)'));
  });

  it('removes secret values and local file paths from connector upsert configuration', () => {
    const { result, bearerToken, headerToken, formPassword } = importCurlWithSecrets();
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const config = connectorConfigFromDraft(result.draft);
    assert.deepEqual(config.auth, {
      type: 'BEARER',
      headerName: 'Authorization',
      secretPresent: true,
    });
    assert.deepEqual(config.headers, [{ name: 'X-Trace-Id', value: 'trace-17' }]);
    assert.deepEqual(config.redactedHeaderNames, ['X-Custom-Token']);
    assert.deepEqual(config.formFields, [{ name: 'username', value: 'alice' }]);
    assert.deepEqual(config.secretFormFieldNames, ['password']);
    assert.deepEqual(config.fileFormFieldNames, ['document']);

    const plan = buildConnectorUpsertParams(result.draft, {
      connectorId: ' connector-a ',
      adapter: ' http ',
      credentialRef: ' vault-entry-17 ',
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.params.mode, 'create');
    assert.equal(plan.params.connectorId, 'connector-a');
    assert.equal(plan.params.adapter, 'http');
    assert.equal(plan.params.credentialRef, 'vault-entry-17');

    const payload = JSON.stringify(plan.params);
    for (const sensitive of [bearerToken, headerToken, formPassword, '/private/customer-file.pdf']) {
      assert.ok(!payload.includes(sensitive), `upsert payload must not contain ${sensitive}`);
    }
  });

  it('wires the tested fail-closed state into Connectors screen controls offline', () => {
    assert.match(screenSource, /const caps = capabilities\.kind === 'ready' \? capabilities\.data : null;/);
    assert.match(screenSource, /const gating = connectorActionGating\(caps\);/);
    assert.match(screenSource, /const validTenantSelected = isTenantUuid\(tenantId\);/);
    assert.match(screenSource, /upsert: gating\.upsert && validTenantSelected/);
    assert.match(screenSource, /disabled=\{!screenGating\.test \|\| busy\}/);
    assert.match(screenSource, /disabled=\{!screenGating\.activate \|\| activeRevision === null \|\| busy\}/);
    assert.match(screenSource, /disabled=\{!screenGating\.disable \|\| busy\}/);
    assert.match(screenSource, /disabled=\{!screenGating\.retire \|\| busy\}/);
    assert.match(screenSource, /const upsertPlan = importDraft === null \? null : buildConnectorUpsertParams/);
    assert.match(screenSource, /if \(upsertPlan === null \|\| !upsertPlan\.ok\) return;/);
    assert.match(screenSource, /if \(!screenGating\[required\]\)/);
    assert.match(screenSource, /async function testConnection\(id: string\): Promise<void> \{\s+if \(!validTenantSelected\)/);
    assert.match(screenSource, /client\.upsertConnector\(params, crypto\.randomUUID\(\)\)/);
    assert.match(screenSource, /capabilities=\{caps\}/);
    assert.match(paritySource, /capabilities\?\.management === true/);
    assert.match(paritySource, /capabilities\?\.test === true/);
    assert.match(paritySource, /session\.principal\.kind === 'tenant_operator'[\s\S]*?session\.principal\.tenantId === tenantId/);
    assert.match(paritySource, /credentialMode === 'vault-ref' && !mayImportManagedSecrets/);
    assert.match(paritySource, /Managed import requires an available Connector credential writer/);
    assert.match(paritySource, /const validTenantSelected = isTenantUuid\(tenantId\);/);
    assert.match(paritySource, /option value="replace" disabled=\{!mayManageCredentials\}/);
    assert.match(paritySource, /option value="vault-ref" disabled=\{!mayImportManagedSecrets\}/);
    assert.match(paritySource, /client\.activateConnectorRevision\(targetConnectorId, targetRevision, requestedTenantId/);
    assert.match(paritySource, /const requestedTenantId = tenantId;[\s\S]*?const isCurrentMutation = \(\): boolean => isCurrentTenantConnectorRequest\(/);
    assert.match(paritySource, /const response = await client\.activateConnectorRevision\(targetConnectorId, targetRevision, requestedTenantId,[\s\S]*?if \(!isCurrentMutation\(\)\) return;/);
    assert.match(paritySource, /setExpectedHeadRevision\(revision\.revision\)/);
    assert.doesNotMatch(paritySource, /setExpectedHeadRevision\(reread\.data\.expectedHeadRevision\)/);
    assert.match(paritySource, /setExpectedHeadRevision\(currentHeadRevision\)/);
    assert.match(paritySource, /const requestedTenantId = selection\?\.tenantId \?\? tenantId;/);
    assert.match(paritySource, /const requestedConnectorId = selection\?\.connectorId \?\? connectorId\.trim\(\);/);
    assert.match(paritySource, /const requestedRevision = selection\?\.revision \?\? Number\(revisionText\);/);
    assert.match(paritySource, /response\.data\.tenantId\.toLowerCase\(\) !== requestedTenantId\.toLowerCase\(\)/);
    assert.match(paritySource, /response\.data\.connectorId !== requestedConnectorId/);
    assert.match(paritySource, /response\.data\.revision !== requestedRevision/);
    assert.match(screenSource, /summarizeConnectorConfig\(row\.config\)/);
    assert.match(screenSource, /summarizeConnectorConfig\(read\.revision\.config\)/);
  });
});
