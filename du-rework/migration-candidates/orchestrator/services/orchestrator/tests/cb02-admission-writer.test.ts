import {
  ProfileCallbackPolicySchema,
  ProfileCallbackPolicySnapshotSchema,
  ProfileEndpointPolicySchema,
  type ProfileCallbackPolicy,
} from '@du/contracts';
import {
  buildCallbackPolicySnapshot,
  buildProfilePolicySnapshot,
} from '../src/modules/operations/submission';
import { EMPTY_PROFILE_POLICY_READ, profileDetailPolicyRead } from '../src/modules/admin-read/profile-detail';

/**
 * CB-02 (B3) — admission writer + profile read wire for the callback policy.
 * Offline, no DB: the contract shapes, the snapshot builder and the read
 * projection are pure.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const policy: ProfileCallbackPolicy = {
  version: 1,
  mode: 'notification_with_result',
  auth: {
    method: 'oauth2_client_credentials',
    grantType: 'client_credentials',
    tokenUrl: 'https://idp.example.com/token',
    clientId: 'client-1',
    clientSecretRef: { kind: 'managed-secret', ref: 'synthetic/client' },
    clientAuthMethod: 'client_secret_post',
  },
  destination: { approvedOrigins: ['https://receiver.example.com'] },
};

function pinnedProfile(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'pinned' as const,
    profileId: '22222222-2222-4222-8222-222222222222',
    revision: 3,
    profileName: 'extract.invoice',
    bindings: {},
    policy: {
      enabled: true,
      parameters: {},
      jobPriority: 'MEDIUM' as const,
      allowedFileExtensions: '',
      connectionsOverride: [],
      fileUrlAuthConfig: null,
      callbackPolicy: policy,
    },
    effectiveParameters: {},
    passthrough: {},
    effectiveInput: {},
    bullMqPriority: 10,
    ...overrides,
  };
}

describe('CB-02 B3 profile contracts carry the callback policy', () => {
  it('the write schema accepts a valid policy, explicit null and rejects malformed ones', () => {
    expect(ProfileEndpointPolicySchema.safeParse({ callbackPolicy: policy }).success).toBe(true);
    expect(ProfileEndpointPolicySchema.safeParse({ callbackPolicy: null }).success).toBe(true);
    expect(ProfileEndpointPolicySchema.safeParse({ callbackPolicy: { version: 1, mode: 'surprise' } }).success).toBe(false);
    // Credential-bearing auth without an approved destination is refused by the
    // frozen CB-01 refine, not only by the dispatcher.
    expect(ProfileEndpointPolicySchema.safeParse({
      callbackPolicy: { ...policy, destination: null },
    }).success).toBe(false);
  });

  it('buildCallbackPolicySnapshot pins identity + revision, and returns null when unconfigured', () => {
    const profile = pinnedProfile();
    const snapshot = buildCallbackPolicySnapshot(profile, {
      tenantId: TENANT,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      endpointKey: 'extract',
    });
    expect(snapshot).not.toBeNull();
    expect(ProfileCallbackPolicySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({
      tenantId: TENANT,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      profileName: 'extract.invoice',
      endpointKey: 'extract',
      profileRevision: 3,
    });
    expect((snapshot as { policy: unknown }).policy).toEqual(policy);

    const none = buildCallbackPolicySnapshot(
      pinnedProfile({ policy: { ...profile.policy, callbackPolicy: null } }),
      { tenantId: TENANT, businessId: 'document-core', businessVersion: '1.0.0', endpointKey: 'extract' },
    );
    expect(none).toBeNull();
  });

  it('falls back to the stable profileId when the name registry has no row', () => {
    const snapshot = buildCallbackPolicySnapshot(
      pinnedProfile({ profileName: null }),
      { tenantId: TENANT, businessId: 'document-core', businessVersion: '1.0.0', endpointKey: 'extract' },
    );
    expect(snapshot).toMatchObject({ profileName: '22222222-2222-4222-8222-222222222222' });
  });

  it('the existing profile policy snapshot stays byte-compatible (no callback field added)', () => {
    const snapshot = buildProfilePolicySnapshot(pinnedProfile(), TENANT) as Record<string, unknown>;
    expect(Object.keys(snapshot)).toEqual([
      'enabled', 'parameters', 'jobPriority', 'allowedFileExtensions',
      'connectionsOverride', 'fileUrlAuthConfigured', 'credentialRef',
    ]);
  });

  it('the frozen CB-01 policy validates independently of the profile DTO', () => {
    expect(ProfileCallbackPolicySchema.safeParse(policy).success).toBe(true);
  });
});

describe('CB-02 B3 profile detail read wire projects the callback policy', () => {
  it('maps a stored policy into the read shape and keeps null explicit', () => {
    const base = {
      profile_id: '22222222-2222-4222-8222-222222222222',
      revision: 3,
      api_key_id: '33333333-3333-4333-8333-333333333333',
      enabled: true,
      parameters: {},
      job_priority: 'MEDIUM',
      allowed_file_extensions: '',
      connections_override: [],
      file_url_auth_cipher: null,
    };
    const withPolicy = profileDetailPolicyRead({ ...base, callback_policy: policy });
    expect(withPolicy.callbackPolicy).toEqual(policy);

    const without = profileDetailPolicyRead({ ...base, callback_policy: null });
    expect(without.callbackPolicy).toBeNull();

    const malformed = profileDetailPolicyRead({ ...base, callback_policy: { mode: 'surprise' } });
    expect(malformed.callbackPolicy).toBeNull();
  });

  it('the blank-editor read shape exposes callbackPolicy: null (never a fabricated policy)', () => {
    expect(EMPTY_PROFILE_POLICY_READ.callbackPolicy).toBeNull();
  });
});
