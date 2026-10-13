export interface ProfileTenantScope {
  tenantId: string | null;
  generation: number;
}

export interface ProfileRequestToken extends ProfileTenantScope {
  request: number;
}

/** Tracks async Profile reads so a previous tenant can never repopulate the editor. */
export function createProfileRequestScope(initialTenantId: string | null) {
  let tenantId = initialTenantId;
  let tenantGeneration = 0;
  let requestGeneration = 0;

  return {
    updateTenant(nextTenantId: string | null): boolean {
      if (tenantId === nextTenantId) return false;
      tenantId = nextTenantId;
      tenantGeneration += 1;
      requestGeneration += 1;
      return true;
    },
    captureTenant(): ProfileTenantScope {
      return { tenantId, generation: tenantGeneration };
    },
    beginRequest(): ProfileRequestToken {
      requestGeneration += 1;
      return { tenantId, generation: tenantGeneration, request: requestGeneration };
    },
    captureRequest(): ProfileRequestToken {
      return { tenantId, generation: tenantGeneration, request: requestGeneration };
    },
    isTenantCurrent(scope: ProfileTenantScope): boolean {
      return scope.tenantId === tenantId && scope.generation === tenantGeneration;
    },
    isRequestCurrent(token: ProfileRequestToken): boolean {
      return token.tenantId === tenantId
        && token.generation === tenantGeneration
        && token.request === requestGeneration;
    },
    invalidateRequests(): void {
      requestGeneration += 1;
    },
  };
}

export interface ProfileApiKeyChoice {
  id: string;
  tenantId: string;
  status: string;
}

/** Only keys owned by the current tenant and still active can be selected for writes. */
export function findCurrentActiveProfileApiKey<T extends ProfileApiKeyChoice>(
  keys: readonly T[],
  keyId: string,
  tenantId: string | null,
): T | undefined {
  if (!tenantId || !keyId) return undefined;
  return keys.find((key) => key.id === keyId && key.tenantId === tenantId && key.status === 'ACTIVE');
}

