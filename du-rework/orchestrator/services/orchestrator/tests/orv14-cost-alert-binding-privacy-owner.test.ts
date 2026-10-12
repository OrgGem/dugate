import {
  costAlertBindingActorLabel,
  safeCostAlertBindingUpdatedBy,
} from '../src/modules/cost-alerts/service';

const OPAQUE_RECIPIENT = '11111111-1111-4111-8111-111111111111';
const VERIFIED_SUBJECT = 'finance-admin@example.test';
const UUID_SUBJECT = '22222222-2222-4222-8222-222222222222';

describe('ORV14 cost-alert binding actor privacy', () => {
  test('new OIDC binding labels use the server-generated opaque recipient, never the IdP subject', () => {
    const label = costAlertBindingActorLabel({
      issuer: 'https://login.example.test',
      role: 'admin',
      localPrincipalId: VERIFIED_SUBJECT,
      alertPrincipalId: OPAQUE_RECIPIENT,
    });

    expect(label).toBe(`oidc-principal:${OPAQUE_RECIPIENT}`);
    expect(label).not.toContain(VERIFIED_SUBJECT);
  });

  test('historical subjects, including UUID-shaped session labels, are masked', () => {
    expect(safeCostAlertBindingUpdatedBy(`session:${VERIFIED_SUBJECT}`)).toBe('Administrator session');
    expect(safeCostAlertBindingUpdatedBy(`session:${UUID_SUBJECT}`)).toBe('Administrator session');
    expect(safeCostAlertBindingUpdatedBy('finance-admin@example.test')).toBe('Administrator session');
    expect(safeCostAlertBindingUpdatedBy(`oidc-principal:${OPAQUE_RECIPIENT}`)).toBe(`oidc-principal:${OPAQUE_RECIPIENT}`);
    expect(safeCostAlertBindingUpdatedBy(`local-user:${OPAQUE_RECIPIENT}`)).toBe(`local-user:${OPAQUE_RECIPIENT}`);
    expect(safeCostAlertBindingUpdatedBy('platform-token')).toBe('platform-token');
  });
});
