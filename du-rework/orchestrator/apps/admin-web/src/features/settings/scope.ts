export interface SettingsScope {
  tenantId: string | null;
  apiKeyId: string;
  endpointSlug: string;
}

export function settingsScopeKey(scope: SettingsScope): string {
  return JSON.stringify([scope.tenantId ?? '', scope.apiKeyId, scope.endpointSlug]);
}

export function isLegacyConnectionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Refuse to display a response unless the server echoed the requested scope. */
export function settingsResponseMatchesScope(value: unknown, target: SettingsScope): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const scope = (value as Record<string, unknown>)['scope'];
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return false;
  const echoed = scope as Record<string, unknown>;
  return echoed['tenantId'] === target.tenantId
    && echoed['apiKeyId'] === (target.apiKeyId || null)
    && echoed['endpointSlug'] === (target.apiKeyId ? target.endpointSlug : null);
}
