import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface AcceptanceCase {
  id: string;
  requiredEvidence: string;
}

interface LegacyProcessFixture {
  process: string;
  endpointSlug: string;
  formVariables: string[];
  requiredAtSubmit: { fileCountMinimum: number; workerFileCountMinimum?: number };
}

interface LegacyContractFixture {
  namedProcesses: LegacyProcessFixture[];
  namedSubmit: {
    fileFields: string[];
    success: {
      status: number;
      operationLocation: string;
      body: {
        name: string;
        done: boolean;
        metadata: Record<string, unknown>;
      };
    };
  };
  schemaSubmit: {
    filesOptional: boolean;
    success: { status: number; body: { metadata: Record<string, unknown> } };
    oldInputObjectGuard: string;
  };
  securityExceptions: string[];
  schemaNodeTypes: string[];
}

interface SchemaNodeFixture {
  id: string;
  type: string;
  branches?: SchemaNodeFixture[][];
}

interface SchemaFixture {
  nodes: SchemaNodeFixture[];
  flow: string[];
  output: { from: string; extra_data_from: string };
}

const fixturePath = (...parts: string[]): string => join(__dirname, 'fixtures', ...parts);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function nestedNodes(nodes: SchemaNodeFixture[]): SchemaNodeFixture[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.branches ?? []).flatMap((branch) => nestedNodes(branch)),
  ]);
}

describe('WFA parity fixture guard', () => {
  const contract = readJson<LegacyContractFixture>(fixturePath('legacy-contract-baseline.json'));
  const schema = readJson<SchemaFixture>(fixturePath('schema-primitives.json'));
  const cases = readJson<AcceptanceCase[]>(fixturePath('acceptance-cases.json'));

  test('keeps all WFA-T01..38 acceptance IDs and evidence requirements visible', () => {
    expect(cases).toHaveLength(38);
    expect(cases.map((testCase) => testCase.id)).toEqual(
      Array.from({ length: 38 }, (_, index) => `WFA-T${String(index + 1).padStart(2, '0')}`),
    );
    for (const testCase of cases) expect(testCase.requiredEvidence.trim().length).toBeGreaterThan(0);
  });

  test('freezes the three actual legacy process names, aliases, and initial envelope', () => {
    expect(contract.namedProcesses.map((process) => process.process)).toEqual([
      'disbursement',
      'lc-checker',
      'doc-compare',
    ]);
    expect(contract.namedProcesses.map((process) => process.endpointSlug)).toEqual([
      'workflows:disbursement',
      'workflows:lc-checker',
      'workflows:doc-compare',
    ]);
    expect(contract.namedProcesses[0]?.formVariables).toEqual(['resolution_data']);
    expect(contract.namedProcesses[1]?.formVariables).toEqual([]);
    expect(contract.namedProcesses[2]?.requiredAtSubmit.workerFileCountMinimum).toBe(2);
    expect(contract.namedSubmit.fileFields).toEqual(['files[]', 'source_file', 'target_file', 'file']);
    expect(contract.namedSubmit.success).toMatchObject({
      status: 202,
      operationLocation: '/api/v1/operations/{id}',
      body: {
        name: 'operations/{id}',
        done: false,
        metadata: {
          state: 'RUNNING',
          progress_percent: 0,
          progress_message: 'Initializing workflow...',
        },
      },
    });
  });

  test('keeps the schema input hardening exception and input-only success case explicit', () => {
    expect(contract.schemaSubmit.filesOptional).toBe(true);
    expect(contract.schemaSubmit.success.status).toBe(202);
    expect(contract.schemaSubmit.success.body.metadata.progress_message).toBe('Initializing schema workflow...');
    expect(contract.schemaSubmit.oldInputObjectGuard).toContain('strict object check');
    expect(contract.securityExceptions.some((exception) => exception.includes('oldest ADMIN key'))).toBe(true);
  });

  test('covers all ten legacy node types, nested parallel branches, and the human checkpoint', () => {
    const foundTypes = new Set(nestedNodes(schema.nodes).map((node) => node.type));
    expect([...foundTypes].sort()).toEqual([...contract.schemaNodeTypes].sort());
    expect(schema.flow.indexOf('human_approval')).toBeGreaterThan(schema.flow.indexOf('extract_sources'));
    expect(schema.flow.indexOf('final_result')).toBeGreaterThan(schema.flow.indexOf('human_approval'));
    expect(schema.output).toEqual({ from: 'final_result', extra_data_from: 'joined_review' });
  });
});
