import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Offline contract fences for the multi-container integration suite (R24-02 / P5-10 lane).
 *
 * These tests read the suite source with node:fs only — they open no PostgreSQL or Redis
 * connection, so they pin R24-02 behaviour without occupying the shared :5433/:6380 test window.
 * Runtime behaviour still needs the LIVE_INFRA run; a green run here is not test evidence.
 */
describe('Document-Core Multi-Container Suite Bootstrap Contract (R24-02)', () => {
  const suitePath = path.join(__dirname, 'multi-container-e2e.integration.test.ts');
  const childRunnerPath = path.join(__dirname, 'helpers', 'child-worker-runner.cjs');

  const suiteSource = fs.readFileSync(suitePath, 'utf8');
  const childRunnerSource = fs.readFileSync(childRunnerPath, 'utf8');

  function countMatches(source: string, regex: RegExp): number {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    return Array.from(source.matchAll(new RegExp(regex.source, flags))).length;
  }

  it('activates the business version instead of relying on ambient DB state', () => {
    const enableIndex = suiteSource.indexOf('/enable`');
    const activateIndex = suiteSource.indexOf('/activate`');
    const firstSubmitIndex = suiteSource.indexOf('/actions/extract');

    expect(enableIndex).toBeGreaterThanOrEqual(0);
    // `/enable` only flips status; submission resolves the version through is_active
    // (services/orchestrator/src/modules/operations/submission.ts) and is_active defaults to false.
    expect(activateIndex).toBeGreaterThanOrEqual(0);
    expect(activateIndex).toBeGreaterThan(enableIndex);
    expect(firstSubmitIndex).toBeGreaterThan(activateIndex);
  });

  it('confirms the active pointer in DB after activating, not just the HTTP status', () => {
    expect(suiteSource).toMatch(/SELECT status, is_active FROM business_versions/);
    expect(suiteSource).toMatch(/status: 'ENABLED', is_active: true/);
  });

  it('keeps the FIX-CR-13 blob rewrite and base64 fallback out of the suite source', () => {
    const FORBIDDEN = [
      /globalThis\.fetch/,
      /originalFetch/,
      /rawBase64/,
      /\bunquoted\b/,
      /artifacts\/blob/,
      /from\(\s*\w+\s*,\s*'base64'\s*\)/,
    ];
    for (const pattern of FORBIDDEN) {
      expect({ pattern: pattern.source, suite: countMatches(suiteSource, pattern) }).toEqual({
        pattern: pattern.source,
        suite: 0,
      });
      expect({ pattern: pattern.source, childRunner: countMatches(childRunnerSource, pattern) }).toEqual({
        pattern: pattern.source,
        childRunner: 0,
      });
    }
  });

  it('authorizes every direct connector invocation GET with a bound invocation grant', () => {
    // Connector requires x-invocation-grant on GET/cancel and validates it against the stored
    // request (services/connector/src/services.ts → authorizeInvocation). A grant-less GET returning
    // 403 is correct behaviour, so the fixture must send a real grant instead of relaxing auth.
    expect(countMatches(suiteSource, /headers: \{ 'x-invocation-grant': await signedInvocationGrant/)).toBe(2);
    // The two granted reads are paired with two negative probes proving the gate is real.
    expect(countMatches(suiteSource, /expect\(ungranted(Resp|Poll)\.status\)\.toBe\(403\)/)).toBe(2);
    // Grants must be minted from the stored ledger row, not from hand-written claims.
    expect(suiteSource).toMatch(/SELECT request, input_hash FROM connector_invocations/);
    // No connector GET may be issued without either a grant header or an explicit 403 expectation.
    expect(countMatches(suiteSource, /fetch\(\`\$\{connectorUrl\}\/invocations\//)).toBe(4);
  });

  it('routes every artifact blob download through the single integrity-checked downloader', () => {
    // One dereference of downloadUrl only: inside downloadArtifactBytes. Widening it would silently
    // re-introduce unverified reads that bypass the sha256/size_bytes comparison.
    expect(countMatches(suiteSource, /fetch\(accessGrant\.downloadUrl!/)).toBe(1);
    expect(suiteSource).toMatch(/createHash\('sha256'\)\.update\(bytes\)\.digest\('hex'\)/);
    expect(suiteSource).toMatch(/bytes\.byteLength/);
    expect(suiteSource).not.toMatch(/rawContent/);
  });

  it('pins the determinism guards that replaced the reported failures', () => {
    // version pinning: 1.1.0 must be enabled *and* activated, and the active pointer restored
    // before the scoped DELETE (activateVersion clears any previous pointer).
    expect(suiteSource).toMatch(/status: 'ENABLED', is_active: false/);
    expect(suiteSource.indexOf('reactivateV1Resp')).toBeLessThan(
      suiteSource.indexOf("'DELETE FROM business_versions WHERE business_id = $1 AND version = $2'")
    );

    // crash lease: no unordered single-task read may come back (an operation can own fan-out child
    // tasks), and the 5s background lease sweeper must stay disabled so it cannot null leased_by
    // mid-assertion.
    expect(countMatches(suiteSource, /FROM tasks WHERE operation_id = \$1 LIMIT 1/)).toBe(0);
    // 3 SQL sites filter the root row directly; the crash test selects every row then filters in JS.
    expect(countMatches(suiteSource, /task_key = 'root'/g)).toBe(3);
    expect(countMatches(suiteSource, /task_key === 'root'/g)).toBeGreaterThanOrEqual(1);
    expect(suiteSource).toMatch(/leaseRecoveryIntervalMs:\s*0/);

    // PRF-02 cascade: the suite worker must be restorable outside the failing test's own body.
    expect(suiteSource).toMatch(/afterEach\(async/);
    expect(suiteSource).toMatch(/worker-restored-/);
  });

  it('does not skip or focus any test case in the suite', () => {
    expect(countMatches(suiteSource, /^\s*(?:it|test|describe)\.(?:skip|only|todo)\b/m)).toBe(0);
    expect(countMatches(suiteSource, /^\s*x(?:it|describe|test)\b/m)).toBe(0);
    // 13 cases are declared; the acceptance bar is 13 executed, not a filtered subset.
    expect(countMatches(suiteSource, /^ {2}(?:it|test)\(/m)).toBe(13);
  });
});
