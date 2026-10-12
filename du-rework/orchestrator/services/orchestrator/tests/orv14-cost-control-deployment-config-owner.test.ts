import { costControlConnectorTokenFromEnv } from '../src/main';

describe('production cost-control service credential boot validation', () => {
  const token = 'dedicated-cost-control-token-value-at-least-32-bytes';

  it('requires the service credential on ordinary production boots', () => {
    expect(() => costControlConnectorTokenFromEnv({ NODE_ENV: 'production' }))
      .toThrow(/required for production cost-control authorization/);
    expect(costControlConnectorTokenFromEnv({
      NODE_ENV: 'production', COST_CONTROL_CONNECTOR_TOKEN: token,
    })).toBe(token);
  });

  it('allows a missing token only for the fixed isolated restore rehearsal mode', () => {
    expect(costControlConnectorTokenFromEnv({
      NODE_ENV: 'production', DU_ISOLATED_RUNTIME_MODE: 'restore-rehearsal',
    })).toBeUndefined();
  });

  it('rejects short and reused credentials without exposing their value', () => {
    expect(() => costControlConnectorTokenFromEnv({ COST_CONTROL_CONNECTOR_TOKEN: 'short' }))
      .toThrow(/32–512 characters/);
    expect(() => costControlConnectorTokenFromEnv({
      COST_CONTROL_CONNECTOR_TOKEN: token, SERVICE_IDENTITY_SECRET: token,
    })).toThrow(/distinct from every other service credential/);
  });
});
