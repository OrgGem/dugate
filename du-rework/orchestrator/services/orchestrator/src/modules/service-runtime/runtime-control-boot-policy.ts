export function assertProductionRuntimeControlConfigured(input: {
  nodeEnv: string | undefined;
  isolatedRuntimeMode: 'restore-rehearsal' | undefined;
  configured: boolean;
}): void {
  if (input.nodeEnv === 'production' && input.isolatedRuntimeMode !== 'restore-rehearsal' && !input.configured) {
    throw new Error('DU_ORCHESTRATOR_RUNTIME_IDENTITY, SLOT, REVISION, IMAGE_DIGEST, and SERVICE_RUNTIME_CONTROL_TOKEN are required in production');
  }
}
