/**
 * Browser-safe Identity wire adapter. The Admin BFF route is being registered
 * separately; this adapter accepts only safe identity projections and never
 * renders or logs untrusted response fields.
 */
export type IdentityRole = 'ADMIN' | 'USER' | 'VIEWER';
export type IdentityAuthMode = 'local' | 'oidc' | 'both' | 'unmanaged';

export interface IdentityUser {
  id: string;
  username: string;
  role: IdentityRole;
  enabled: boolean;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface IdentityOidcMetadata {
  issuer: string;
  clientId: string;
  callbackUrl: string;
  scopes: string[];
}

export interface IdentitySnapshot {
  users: IdentityUser[];
  capabilities: { userWriter: boolean };
  auth: {
    mode: IdentityAuthMode;
    localEnabled: boolean;
    oidc: IdentityOidcMetadata | null;
  };
}

export interface IdentityApiFailure {
  status: number;
  code: string;
}

export type IdentityApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IdentityApiFailure };

export interface CreateIdentityUserInput {
  username: string;
  password: string;
  role: IdentityRole;
}

export interface UpdateIdentityUserInput {
  role: IdentityRole;
  enabled: boolean;
  expectedVersion: number;
}

const IDENTITY_PATH = '/admin/api/identity';

export async function readIdentitySnapshot(): Promise<IdentityApiResult<IdentitySnapshot>> {
  const response = await request('GET', IDENTITY_PATH);
  if (!response.ok) return response;
  const parsed = parseIdentitySnapshot(response.data.body);
  return parsed === null ? failure(response.data.status, 'INVALID_RESPONSE') : { ok: true, data: parsed };
}

export async function createIdentityUser(
  input: CreateIdentityUserInput,
  csrfToken: string,
): Promise<IdentityApiResult<IdentityUser>> {
  const response = await request('POST', `${IDENTITY_PATH}/users`, {
    body: input,
    csrfToken,
  });
  return response.ok ? parseMutationUser(response) : response;
}

export async function updateIdentityUser(
  user: IdentityUser,
  input: UpdateIdentityUserInput,
  csrfToken: string,
): Promise<IdentityApiResult<IdentityUser>> {
  const response = await request('PATCH', `${IDENTITY_PATH}/users/${encodeURIComponent(user.id)}`, {
    body: input,
    csrfToken,
  });
  return response.ok ? parseMutationUser(response) : response;
}

async function request(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: { body?: unknown; csrfToken?: string } = {},
): Promise<IdentityApiResult<{ status: number; body: unknown }>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.csrfToken !== undefined) headers['x-csrf-token'] = options.csrfToken;
  if (method !== 'GET') headers['idempotency-key'] = createIdempotencyKey();

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    return failure(0, 'TRANSPORT_ERROR');
  }

  if (!response.ok) return failure(response.status, safeProblemCode(await response.json().catch(() => null)));
  const body = await response.json().catch(() => null);
  return body === null ? failure(response.status, 'INVALID_RESPONSE') : { ok: true, data: { status: response.status, body } };
}

function parseMutationUser(
  response: IdentityApiResult<{ status: number; body: unknown }>,
): IdentityApiResult<IdentityUser> {
  if (!response.ok) return response;
  const envelope = asRecord(response.data.body);
  const user = envelope === null ? null : parseIdentityUser(envelope.user);
  return user === null ? failure(response.data.status, 'INVALID_RESPONSE') : { ok: true, data: user };
}

function parseIdentitySnapshot(value: unknown): IdentitySnapshot | null {
  const snapshot = asRecord(value);
  if (snapshot === null || !Array.isArray(snapshot.users)) return null;
  const capabilities = asRecord(snapshot.capabilities);
  const auth = asRecord(snapshot.auth);
  if (capabilities === null || typeof capabilities.userWriter !== 'boolean' || auth === null) return null;
  if (
    auth.mode !== 'local' &&
    auth.mode !== 'oidc' &&
    auth.mode !== 'both' &&
    auth.mode !== 'unmanaged'
  ) {
    return null;
  }
  if (typeof auth.localEnabled !== 'boolean') return null;
  const oidc = auth.oidc === null ? null : parseOidcMetadata(auth.oidc);
  if (auth.oidc !== null && oidc === null) return null;
  const users = snapshot.users.map(parseIdentityUser);
  if (users.some((user) => user === null)) return null;

  return {
    users: users.filter((user): user is IdentityUser => user !== null),
    capabilities: { userWriter: capabilities.userWriter },
    auth: { mode: auth.mode, localEnabled: auth.localEnabled, oidc },
  };
}

function parseIdentityUser(value: unknown): IdentityUser | null {
  const user = asRecord(value);
  if (user === null) return null;
  if (
    typeof user.id !== 'string' ||
    typeof user.username !== 'string' ||
    !isIdentityRole(user.role) ||
    typeof user.enabled !== 'boolean' ||
    typeof user.locked !== 'boolean' ||
    typeof user.createdAt !== 'string' ||
    typeof user.updatedAt !== 'string' ||
    typeof user.version !== 'number' ||
    !Number.isSafeInteger(user.version) ||
    user.version < 0
  ) {
    return null;
  }
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    locked: user.locked,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    version: user.version,
  };
}

function parseOidcMetadata(value: unknown): IdentityOidcMetadata | null {
  const metadata = asRecord(value);
  if (
    metadata === null ||
    typeof metadata.issuer !== 'string' ||
    typeof metadata.clientId !== 'string' ||
    typeof metadata.callbackUrl !== 'string' ||
    !Array.isArray(metadata.scopes) ||
    metadata.scopes.some((scope) => typeof scope !== 'string')
  ) {
    return null;
  }
  return {
    issuer: metadata.issuer,
    clientId: metadata.clientId,
    callbackUrl: metadata.callbackUrl,
    scopes: metadata.scopes as string[],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isIdentityRole(value: unknown): value is IdentityRole {
  return value === 'ADMIN' || value === 'USER' || value === 'VIEWER';
}

function safeProblemCode(value: unknown): string {
  const problem = asRecord(value);
  return typeof problem?.code === 'string' && /^[A-Z0-9_-]{1,48}$/.test(problem.code)
    ? problem.code
    : 'HTTP_ERROR';
}

function failure(status: number, code: string): IdentityApiResult<never> {
  return { ok: false, error: { status, code } };
}

function createIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `identity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
