import { hasLocalUserOperationAssignment } from '../src/modules/identity/service';

const BASE = {
  hasApiKey: true,
  currentUser: true,
  activeNonGlobalApiKey: true,
  assignedApiKey: true,
  profileId: 'profile-a',
  assignedProfile: true,
};

describe('local USER operation assignment is a key/profile intersection', () => {
  it('allows an operation when both the exact active key and Profile are assigned', () => {
    expect(hasLocalUserOperationAssignment(BASE)).toBe(true);
  });

  it('denies profile-only access to an operation using another API key', () => {
    expect(hasLocalUserOperationAssignment({ ...BASE, assignedApiKey: false })).toBe(false);
  });

  it('denies key-only access when a non-null operation Profile is not assigned', () => {
    expect(hasLocalUserOperationAssignment({ ...BASE, assignedProfile: false })).toBe(false);
  });

  it('keeps legacy null-Profile operations visible through the exact assigned active key', () => {
    expect(hasLocalUserOperationAssignment({ ...BASE, profileId: null, assignedProfile: true })).toBe(true);
  });

  it('denies null-key legacy operations even when the Profile is assigned', () => {
    expect(hasLocalUserOperationAssignment({ ...BASE, hasApiKey: false, assignedApiKey: false, profileId: null })).toBe(false);
  });

  it('denies stale users, inactive keys, and the protected Global key', () => {
    expect(hasLocalUserOperationAssignment({ ...BASE, currentUser: false })).toBe(false);
    expect(hasLocalUserOperationAssignment({ ...BASE, activeNonGlobalApiKey: false })).toBe(false);
  });
});
