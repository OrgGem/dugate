import { rolloutCutoverExecutorAllowed } from '../src/modules/maintenance/rollouts';

describe('ORV14 dedicated host rollout controller', () => {
  const trustedHostControllerIdentity = 'maintenance-host-bluegreen';

  it('lets the pinned candidate finish its own CUTOVER', () => {
    expect(rolloutCutoverExecutorAllowed({
      service: 'orchestrator', phase: 'CUTOVER', executorIdentity: 'orchestrator-green-candidate',
      candidateRuntimeIdentity: 'orchestrator-green-candidate', trustedHostControllerIdentity,
    })).toBe(true);
  });

  it('lets only the separately pinned host controller finish a handed-off CUTOVER', () => {
    expect(rolloutCutoverExecutorAllowed({
      service: 'orchestrator', phase: 'CUTOVER', executorIdentity: trustedHostControllerIdentity,
      candidateRuntimeIdentity: 'orchestrator-green-candidate', trustedHostControllerIdentity,
    })).toBe(true);
    expect(rolloutCutoverExecutorAllowed({
      service: 'orchestrator', phase: 'CUTOVER', executorIdentity: 'orchestrator-blue-source',
      candidateRuntimeIdentity: 'orchestrator-green-candidate', trustedHostControllerIdentity,
    })).toBe(false);
  });

  it('does not use the host identity to authorize other phases or services', () => {
    expect(rolloutCutoverExecutorAllowed({
      service: 'orchestrator', phase: 'PREPARE', executorIdentity: 'ordinary-web',
      candidateRuntimeIdentity: null,
    })).toBe(true);
    expect(rolloutCutoverExecutorAllowed({
      service: 'connector', phase: 'CUTOVER', executorIdentity: 'ordinary-web',
      candidateRuntimeIdentity: null,
    })).toBe(true);
  });
});
