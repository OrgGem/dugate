import { ApiKeysScreen } from '@/features/api-keys/api-keys-screen';

/** Platform-Admin guarded API key lifecycle route; the feature rechecks the server session. */
export function ApiKeysRoute() {
  return <ApiKeysScreen />;
}
