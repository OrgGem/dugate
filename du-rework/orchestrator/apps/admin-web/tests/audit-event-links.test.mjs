import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import ts from 'typescript';

function extractDeclarations(source, fileName, names) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const remaining = new Set(names);
  const declarations = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    const name = statement.name?.text;
    if (name && remaining.has(name)) {
      declarations.push(statement.getText(sourceFile));
      remaining.delete(name);
    }
  }

  assert.deepEqual([...remaining], [], `${fileName} must retain the audit event link helpers`);
  return declarations.join('\n\n');
}

function loadAuditEventLinks(source, fileName) {
  const compiled = ts.transpileModule(extractDeclarations(source, fileName, ['safeQueryValue', 'auditEventLinks']), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);

  return new Function(`${compiled.outputText}\nreturn auditEventLinks;`)();
}

const auditFile = 'src/features/audit/audit-screen.tsx';
const auditSource = await readFile(new URL(`../${auditFile}`, import.meta.url), 'utf8');
const auditEventLinks = loadAuditEventLinks(auditSource, auditFile);

describe('audit event deep links', () => {
  it('links operation resources to Audit and Trace', () => {
    assert.deepEqual(auditEventLinks('operation:op-17'), {
      audit: '/audit?resource=operation%3Aop-17',
      trace: '/trace?operationId=op-17',
    });
  });

  it('links other valid resources to Audit without inventing a Trace lookup', () => {
    assert.deepEqual(auditEventLinks('business:acme-42'), {
      audit: '/audit?resource=business%3Aacme-42',
      trace: null,
    });
  });

  it('trims and safely encodes special characters in resource and operation values', () => {
    assert.deepEqual(auditEventLinks('  OPERATION:op /+?#:%  '), {
      audit: '/audit?resource=OPERATION%3Aop+%2F%2B%3F%23%3A%25',
      trace: '/trace?operationId=op+%2F%2B%3F%23%3A%25',
    });
  });

  it('returns null links for empty or invalid resource identifiers', () => {
    for (const resourceId of [null, '', '   ', 'operation:bad\nvalue', 'x'.repeat(129)]) {
      assert.deepEqual(auditEventLinks(resourceId), { audit: null, trace: null }, JSON.stringify(resourceId));
    }
  });

  it('keeps a valid Audit link when the operation identifier exceeds its limit', () => {
    const resourceId = `operation:${'x'.repeat(65)}`;

    assert.deepEqual(auditEventLinks(resourceId), {
      audit: `/audit?resource=operation%3A${'x'.repeat(65)}`,
      trace: null,
    });
  });
});
