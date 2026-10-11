import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import ts from 'typescript';

function extractDeclarations(source, fileName, functionNames, variableNames = []) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const remainingFunctions = new Set(functionNames);
  const remainingVariables = new Set(variableNames);
  const declarations = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text;
      if (name && remainingFunctions.has(name)) {
        declarations.push(statement.getText(sourceFile).replace(/^export\s+/, ''));
        remainingFunctions.delete(name);
      }
    } else if (ts.isVariableStatement(statement)) {
      const matchingNames = statement.declarationList.declarations
        .filter((declaration) => ts.isIdentifier(declaration.name) && remainingVariables.has(declaration.name.text))
        .map((declaration) => declaration.name.text);
      if (matchingNames.length > 0) {
        declarations.push(statement.getText(sourceFile).replace(/^export\s+/, ''));
        for (const name of matchingNames) remainingVariables.delete(name);
      }
    }
  }

  assert.deepEqual([...remainingFunctions], [], `${fileName} must retain the production functions covered here`);
  assert.deepEqual([...remainingVariables], [], `${fileName} must retain the production constants covered here`);
  return declarations.join('\n\n');
}

function loadHelpers(source, fileName, functionNames, variableNames = []) {
  const compiled = ts.transpileModule(
    extractDeclarations(source, fileName, functionNames, variableNames),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
      reportDiagnostics: true,
    },
  );
  const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);

  return new Function(`${compiled.outputText}\nreturn { ${functionNames.join(', ')} };`)();
}

const stateFile = 'src/features/connectors/state.ts';
const curlImportFile = 'src/features/connectors/curl-import.ts';
const [stateSource, curlImportSource] = await Promise.all([
  readFile(new URL(`../${stateFile}`, import.meta.url), 'utf8'),
  readFile(new URL(`../${curlImportFile}`, import.meta.url), 'utf8'),
]);

const reader = loadHelpers(
  stateSource,
  stateFile,
  ['isRecord', 'hasOnlyKeys', 'isConnectorRevisionState', 'parseConnectorManagementRevision', 'parseConnectorList'],
  ['CONNECTOR_REVISION_STATES', 'MANAGEMENT_REVISION_KEYS'],
);
const secretNameCheck = loadHelpers(
  curlImportSource,
  curlImportFile,
  ['isSecretTokenName'],
  ['SECRET_NAMES', 'SECRET_NAME_FRAGMENTS'],
);
const configSummary = loadHelpers(
  stateSource,
  stateFile,
  ['isRecord', 'summarizeConnectorConfig'],
);
const summarizeConnectorConfig = new Function(
  'isSecretTokenName',
  `${Object.entries(configSummary).map(([name, helper]) => `const ${name} = (${helper.toString()});`).join('\n')}\nreturn summarizeConnectorConfig;`,
)(secretNameCheck.isSecretTokenName);

describe('connector read and config summary fixtures', () => {
  it('counts malformed list records as skipped while preserving valid records', () => {
    const validActive = {
      connectorId: 'mail-primary',
      revision: 3,
      adapter: 'smtp',
      state: 'ACTIVE',
      config: { host: 'smtp.example.invalid' },
      tenantId: 'tenant-a',
    };
    const validPending = {
      connectorId: 'archive-backup',
      revision: 1,
      adapter: 's3',
      state: 'PENDING',
      config: { bucket: 'archive-example' },
    };
    const malformedRevision = {
      connectorId: 'broken-revision',
      revision: 0,
      adapter: 'smtp',
      state: 'ACTIVE',
      config: {},
    };
    const unexpectedField = {
      connectorId: 'unknown-field',
      revision: 2,
      adapter: 's3',
      state: 'RETIRED',
      config: {},
      backendOnlyField: 'must not be silently accepted',
    };

    const result = reader.parseConnectorList({ items: [validActive, null, malformedRevision, unexpectedField, validPending] });

    assert.deepEqual(result, {
      items: [validActive, validPending],
      skipped: 3,
    });
    assert.equal(result.items.some((item) => item.connectorId === 'broken-revision'), false);
    assert.equal(result.items.some((item) => item.connectorId === 'unknown-field'), false);
  });

  it('summarizes configuration with key and header names but no secret values', () => {
    const secretValues = [
      'top-level-secret-value-17',
      'nested-password-value-23',
      'authorization-bearer-secret-31',
      'session-token-value-47',
      'ordinary-header-value-59',
    ];
    const config = {
      apiToken: secretValues[0],
      endpoint: { password: secretValues[1] },
      headers: [
        { name: 'Authorization', value: secretValues[2] },
        { name: 'X-Session-Token', value: secretValues[3] },
        { name: 'X-Workspace-Label', value: secretValues[4] },
        { name: 'X-Proxy-Secret', value: '[REDACTED]' },
        { name: '', value: 'ignored-header-value' },
        null,
      ],
    };

    const summary = summarizeConnectorConfig(config);

    assert.deepEqual(summary, {
      keys: ['apiToken', 'endpoint', 'headers'],
      headerNames: ['X-Workspace-Label'],
      redactedHeaderNames: ['Authorization', 'X-Session-Token', 'X-Proxy-Secret'],
    });
    const serializedSummary = JSON.stringify(summary);
    for (const secretValue of secretValues) assert.equal(serializedSummary.includes(secretValue), false);
    assert.equal(serializedSummary.includes('ignored-header-value'), false);
  });
});
