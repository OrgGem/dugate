import { runtimeGrantBaseUrlFromEnv } from '../src/main';

describe('Runtime grant origin deployment configuration', () => {
  it('refuses a production PostgreSQL boot without a trusted grant origin', () => {
    expect(() => runtimeGrantBaseUrlFromEnv({ NODE_ENV: 'production' })).toThrow('ORCHESTRATOR_INTERNAL_BASE_URL is required');
    expect(runtimeGrantBaseUrlFromEnv({ NODE_ENV: 'production', ARTIFACT_STORAGE_BACKEND: 's3' })).toBeUndefined();
  });
  it('normalizes an explicitly trusted internal HTTP(S) origin', () => {
    expect(runtimeGrantBaseUrlFromEnv({ ORCHESTRATOR_INTERNAL_BASE_URL: ' http://orchestrator:3002/ ' })).toBe('http://orchestrator:3002');
    expect(runtimeGrantBaseUrlFromEnv({})).toBeUndefined();
  });
  it.each(['file:///tmp/blob', 'http://user:secret@orchestrator:3002', 'http://orchestrator:3002/api', 'http://orchestrator:3002/?token=secret', 'http://orchestrator:3002/#secret', 'invalid-secret'])('rejects invalid configuration without echoing its value', (origin) => {
    expect(() => runtimeGrantBaseUrlFromEnv({ ORCHESTRATOR_INTERNAL_BASE_URL: origin })).toThrow('ORCHESTRATOR_INTERNAL_BASE_URL must be an HTTP(S) origin');
    try { runtimeGrantBaseUrlFromEnv({ ORCHESTRATOR_INTERNAL_BASE_URL: origin }); } catch (error) {
      expect((error as Error).message).not.toContain(origin);
    }
  });
});
