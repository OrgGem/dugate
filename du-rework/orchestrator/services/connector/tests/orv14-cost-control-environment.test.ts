import { costControlFromEnvironment } from '../src/cost-control-environment';

describe('ORV14 production cost-control endpoint configuration', () => {
  it('fails closed when a production Connector has neither endpoint nor token', () => {
    expect(() => costControlFromEnvironment({ NODE_ENV: 'production' }))
      .toThrow('Production Connector requires COST_CONTROL_CONNECTOR_URL and COST_CONTROL_CONNECTOR_TOKEN');
  });

  it('allows the explicit restore rehearsal to omit outbound cost control', () => {
    expect(costControlFromEnvironment({ NODE_ENV: 'production' }, { isolatedRestoreRehearsal: true })).toBeUndefined();
  });

  it('keeps local/test configuration optional and enforces the configured pair', () => {
    expect(costControlFromEnvironment({ NODE_ENV: 'test' })).toBeUndefined();
    expect(() => costControlFromEnvironment({ NODE_ENV: 'production', COST_CONTROL_CONNECTOR_URL: 'http://orchestrator:3002' }))
      .toThrow('configured together');
    expect(costControlFromEnvironment({
      NODE_ENV: 'production',
      COST_CONTROL_CONNECTOR_URL: 'http://orchestrator:3002/',
      COST_CONTROL_CONNECTOR_TOKEN: 'x'.repeat(32),
    })).toEqual({ baseUrl: 'http://orchestrator:3002', token: 'x'.repeat(32) });
  });
});
