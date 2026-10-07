import { verifyLocalPassword } from './password';
import type { LocalLoginGuard } from './login-guard';

export interface LocalCredentialRecord {
  subjectId: string;
  passwordHash: string;
  role: string;
  tenantId: string | null;
}

/** LOCAL-01 repository seam: return only enabled local identities and verifiers. */
export interface LocalCredentialReader {
  findByLogin(login: string): Promise<LocalCredentialRecord | null>;
}

export interface LocalAuthenticatedPrincipal {
  issuer: 'du-local';
  sub: string;
  role: string;
  tenantId: string | null;
}

export type LocalPasswordAuthenticationResult =
  | { authenticated: true; principal: LocalAuthenticatedPrincipal }
  | { authenticated: false; status: 401; body: { error: 'Invalid credentials' } };

export const GENERIC_LOCAL_AUTH_FAILURE: LocalPasswordAuthenticationResult = Object.freeze({
  authenticated: false,
  status: 401,
  body: Object.freeze({ error: 'Invalid credentials' }),
});

export interface LocalPasswordAuthenticationDependencies {
  credentials: LocalCredentialReader;
  loginGuard: LocalLoginGuard;
  /** A valid verifier for a non-account dummy value; never a real account verifier. */
  dummyPasswordHash: string;
  /** Must match the repository's server-side login normalization. */
  subjectKeyForLogin(login: string): string;
}

function isCredentialRecord(value: LocalCredentialRecord | null): value is LocalCredentialRecord {
  return (
    value !== null &&
    typeof value.subjectId === 'string' &&
    value.subjectId.length > 0 &&
    typeof value.passwordHash === 'string' &&
    typeof value.role === 'string' &&
    value.role.length > 0 &&
    (value.tenantId === null || typeof value.tenantId === 'string')
  );
}

/**
 * Authenticate using only server-resolved credential records. Unknown users
 * still incur a dummy password derivation and receive the same generic 401.
 */
export async function authenticateLocalPassword(
  input: { login: string; password: string },
  dependencies: LocalPasswordAuthenticationDependencies,
): Promise<LocalPasswordAuthenticationResult> {
  const login = typeof input?.login === 'string' ? input.login : '';
  const password = typeof input?.password === 'string' ? input.password : '';

  let subjectKey: string;
  try {
    subjectKey = dependencies.subjectKeyForLogin(login);
  } catch {
    await verifyLocalPassword(password, dependencies.dummyPasswordHash);
    return GENERIC_LOCAL_AUTH_FAILURE;
  }

  try {
    const admission = await dependencies.loginGuard.beginAttempt(subjectKey);
    if (!admission.allowed) return GENERIC_LOCAL_AUTH_FAILURE;
  } catch {
    await verifyLocalPassword(password, dependencies.dummyPasswordHash);
    return GENERIC_LOCAL_AUTH_FAILURE;
  }

  let record: LocalCredentialRecord | null = null;
  let lookupFailed = false;
  try {
    record = await dependencies.credentials.findByLogin(login);
  } catch {
    lookupFailed = true;
  }

  const credential = isCredentialRecord(record) ? record : null;
  const verifier = credential?.passwordHash ?? dependencies.dummyPasswordHash;
  const passwordMatches = await verifyLocalPassword(password, verifier);
  if (!credential || lookupFailed || !passwordMatches) {
    try {
      await dependencies.loginGuard.recordFailure(subjectKey);
    } catch {
      // A failed guard update still fails closed with the generic response.
    }
    return GENERIC_LOCAL_AUTH_FAILURE;
  }

  try {
    await dependencies.loginGuard.recordSuccess(subjectKey);
  } catch {
    return GENERIC_LOCAL_AUTH_FAILURE;
  }

  return {
    authenticated: true,
    principal: {
      issuer: 'du-local',
      sub: credential.subjectId,
      role: credential.role,
      tenantId: credential.tenantId,
    },
  };
}
