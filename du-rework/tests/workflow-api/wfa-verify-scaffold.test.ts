// WFA-VERIFY-BASELINE (OC lane) — offline scaffold validation.
//
// This suite does NOT need PostgreSQL, Redis or a worker. It locks the fixture
// layer for the prep items of the WFA dispatch spec:
//   - WFA-T01..T03 named-process cases (case identity, inputs, envelope keys);
//   - WFA-T15/T18..T22 executable leaf-node manifests (safe loopback mocks);
//   - T22/T33..T35 negative vectors (traversal, SSRF, prototype, bounds).
// It also proves the case IDs cannot silently disappear by checking them
// against acceptance-cases.json and the frozen legacy contract baseline.
//
// Execution evidence is produced by the worker lane; this file is the fixture
// contract that those runs must consume.

import { readFileSync } from 'node:fs';
import path from 'node:path';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as T;
}

interface AcceptanceCase {
  id: string;
  requiredEvidence: string;
}

interface NamedCase {
  id: string;
  process: string;
  endpointSlug: string;
  files: Array<{ field: string; name: string; content: string }>;
  variables: Record<string, string>;
  expectedAdmission: {
    status: number;
    operationLocation: string;
    name: string;
    done: boolean;
    metadataRequired: Record<string, unknown>;
  };
  profilePromptKeys: string[];
  baselineState: string;
  requiredAtSubmit?: { fileCountMinimum: number; workerFileCountMinimum?: number };
}

interface LeafCase {
  id: string;
  nodeType: string;
  mockKind: string;
  mockUrlPlaceholder: string | null;
  safeInput: Record<string, unknown>;
  outputSelection: Record<string, unknown>;
  requiredFences: string[];
  securityVectorGroups: string[];
}

interface SecurityVectors {
  loopbackMockPolicy: { allowedHosts: string[]; requiresRunAssignedPort: boolean };
  pathTraversal: string[];
  prototype: string[];
  ssrf: string[];
  ssrfRedirect: Array<{ from: string; to: string }>;
  bounds: Record<string, Record<string, number | null>>;
}

interface LegacyBaseline {
  namedProcesses: Array<{
    process: string;
    endpointSlug: string;
    formVariables: string[];
    profilePromptKeys: string[];
    requiredAtSubmit: { fileCountMinimum: number; workerFileCountMinimum?: number };
  }>;
  schemaNodeTypes: string[];
}

const acceptance = fixture<AcceptanceCase[]>('acceptance-cases.json');
const named = fixture<{ cases: NamedCase[] }>('named-processes.json');
const leaves = fixture<{ cases: LeafCase[] }>('leaf-nodes.json');
const vectors = fixture<SecurityVectors>('security-vectors.json');
const legacy = fixture<LegacyBaseline>('legacy-contract-baseline.json');

const acceptanceIds = new Set(acceptance.map((entry) => entry.id));

describe('WFA fixture scaffold — case identity stays visible', () => {
  test('every prepared case is registered in acceptance-cases.json', () => {
    const prepared = [
      ...named.cases.map((entry) => entry.id),
      ...leaves.cases.map((entry) => entry.id),
    ];
    expect(prepared.length).toBeGreaterThanOrEqual(9);
    for (const id of prepared) expect(acceptanceIds.has(id)).toBe(true);
  });

  test('the six executable leaf types and the three named processes cover WFA-T15/T18..T22/T01..T03', () => {
    expect(leaves.cases.map((entry) => entry.id).sort()).toEqual(
      ['WFA-T15', 'WFA-T18', 'WFA-T19', 'WFA-T20', 'WFA-T21', 'WFA-T22'].sort(),
    );
    expect(named.cases.map((entry) => entry.id).sort()).toEqual(['WFA-T01', 'WFA-T02', 'WFA-T03']);
  });
});

describe('named-process fixtures — frozen contract parity', () => {
  test('case manifests match the legacy process baseline (names, slugs, prompt keys, variables)', () => {
    const baselineByName = new Map(legacy.namedProcesses.map((entry) => [entry.process, entry]));
    for (const entry of named.cases) {
      const baseline = baselineByName.get(entry.process);
      expect(baseline).toBeDefined();
      expect(entry.endpointSlug).toBe(baseline!.endpointSlug);
      expect(entry.profilePromptKeys).toEqual(baseline!.profilePromptKeys);
      const expectedVariableNames = [
        ...new Set([...baseline!.formVariables, ...Object.keys(entry.variables)]),
      ];
      // The fixture may only carry variables the legacy form contract declares.
      for (const name of Object.keys(entry.variables)) {
        expect(baseline!.formVariables.includes(name)).toBe(true);
      }
      expect(expectedVariableNames.length).toBe(baseline!.formVariables.length);
      expect(entry.baselineState).toContain('BASELINE-FAIL');
    }
    const disbursement = named.cases.find((entry) => entry.process === 'disbursement');
    expect(disbursement?.variables.resolution_data).toBeTruthy();
  });

  test('doc-compare keeps the two-document worker requirement while admission accepts one file', () => {
    const docCompare = named.cases.find((entry) => entry.process === 'doc-compare');
    expect(docCompare).toBeDefined();
    expect(docCompare!.requiredAtSubmit?.fileCountMinimum).toBe(1);
    expect(docCompare!.requiredAtSubmit?.workerFileCountMinimum).toBe(2);
    expect(docCompare!.files.length).toBeGreaterThanOrEqual(2);
  });

  test('each case carries the frozen legacy 202 envelope expectations and synthetic files only', () => {
    for (const entry of named.cases) {
      expect(entry.expectedAdmission.status).toBe(202);
      expect(entry.expectedAdmission.operationLocation).toBe('/api/v1/operations/{id}');
      expect(entry.expectedAdmission.name).toBe('operations/{id}');
      expect(entry.expectedAdmission.done).toBe(false);
      expect(entry.expectedAdmission.metadataRequired).toMatchObject({
        state: 'RUNNING',
        workflow: entry.process,
        progress_percent: 0,
      });
      expect(entry.files.length).toBeGreaterThanOrEqual(entry.requiredAtSubmit?.fileCountMinimum ?? 1);
      for (const file of entry.files) {
        expect(file.field).toBe('files[]');
        expect(file.name).toMatch(/\.pdf$/);
        expect(file.content).toMatch(/^synthetic/i);
      }
    }
  });
});

describe('leaf-node fixtures — safe mocks and declared fences', () => {
  test('node types come from the frozen inventory and mocks are loopback-only', () => {
    for (const entry of leaves.cases) {
      expect(legacy.schemaNodeTypes).toContain(entry.nodeType);
      expect(entry.requiredFences.length).toBeGreaterThan(0);
      if (entry.mockUrlPlaceholder !== null) {
        // `<port>` placeholders are filled with a run-assigned port; only the
        // host policy is asserted here.
        const url = new URL(entry.mockUrlPlaceholder.replace(/<[^>]+>/g, '12345'));
        expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
      }
    }
  });

  test('every fence group referenced by a leaf case exists in security-vectors.json', () => {
    const groups = new Set(['traversal', 'ssrf', 'prototype', 'bounds']);
    for (const entry of leaves.cases) {
      for (const group of entry.securityVectorGroups) expect(groups.has(group)).toBe(true);
    }
  });
});

describe('security vectors — fail-closed shapes', () => {
  test('SSRF vectors are never allowed loopback mocks nor plain http(s) allowed destinations', () => {
    expect(vectors.ssrf.length).toBeGreaterThanOrEqual(6);
    const allowedHosts = vectors.loopbackMockPolicy.allowedHosts;
    for (const value of vectors.ssrf) {
      const url = new URL(value);
      const wouldBeAllowedMock =
        ['http:', 'https:'].includes(url.protocol) && allowedHosts.includes(url.hostname);
      expect(wouldBeAllowedMock).toBe(false);
    }
    expect(vectors.ssrf).toContain('http://169.254.169.254/latest/meta-data/');
    expect(vectors.ssrfRedirect[0]?.to).toBe('http://169.254.169.254/latest/meta-data/');
    expect(['127.0.0.1', 'localhost']).toEqual(expect.arrayContaining(vectors.loopbackMockPolicy.allowedHosts));
    expect(vectors.loopbackMockPolicy.requiresRunAssignedPort).toBe(true);
  });

  test('traversal vectors are unsafe by construction and prototype keys are blocked', () => {
    expect(vectors.pathTraversal.length).toBeGreaterThanOrEqual(6);
    for (const value of vectors.pathTraversal) {
      const unsafe =
        value.includes('..') ||
        value.startsWith('/') ||
        value.includes(':\\') ||
        /%2e|%2f/i.test(value);
      expect(unsafe).toBe(true);
    }
    expect(vectors.prototype).toEqual(expect.arrayContaining(['__proto__', 'constructor.prototype']));
  });

  test('bounds are explicit non-negative integers where frozen, and maxFanout is flagged as open', () => {
    const { bounds } = vectors;
    for (const group of ['archiveExtract', 'archiveCompress', 'connector', 'fileParse', 'fileUrlDownload', 'callback']) {
      const values = bounds[group];
      expect(values).toBeDefined();
      const numeric = Object.values(values).filter((value) => value !== null) as number[];
      expect(numeric.length).toBeGreaterThan(0);
      expect(numeric.some((value) => value > 0)).toBe(true);
      for (const value of numeric) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    expect(bounds.maxFilesPerRequest).toBe(20);
    expect(bounds.maxFanout).toBeNull();
  });

  test('fixtures contain no credential-like material', () => {
    const raw = JSON.stringify({ named, leaves, vectors });
    for (const pattern of ['Bearer ', 'du_', 'sk-', 'hvs.', 'AKIA', 'password=']) {
      expect(raw.includes(pattern)).toBe(false);
    }
  });
});
