import { assertProductionRuntimeControlConfigured } from '../src/modules/service-runtime/runtime-control-boot-policy';

describe('production runtime-control boot policy', () => {
  test('requires a complete runtime identity for ordinary production', () => {
    expect(() => assertProductionRuntimeControlConfigured({
      nodeEnv: 'production', isolatedRuntimeMode: undefined, configured: false,
    })).toThrow('DU_ORCHESTRATOR_RUNTIME_IDENTITY');
  });

  test('permits non-production process configuration without a replica identity', () => {
    expect(() => assertProductionRuntimeControlConfigured({
      nodeEnv: 'development', isolatedRuntimeMode: undefined, configured: false,
    })).not.toThrow();
  });

  test('does not require a new serving identity for the separately pinned restore rehearsal', () => {
    expect(() => assertProductionRuntimeControlConfigured({
      nodeEnv: 'production', isolatedRuntimeMode: 'restore-rehearsal', configured: false,
    })).not.toThrow();
  });
});
