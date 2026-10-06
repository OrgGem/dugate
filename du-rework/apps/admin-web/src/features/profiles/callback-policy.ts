/**
 * CB-04 — Callback policy draft model for the Profile editor.
 *
 * Mirrors the frozen `@du/contracts` `ProfileCallbackPolicy` shape locally
 * (the browser bundle does not import service code). Rules encoded here:
 *  - an absent policy preserves the existing notification-only behaviour;
 *    a policy is only sent when the operator explicitly configured it;
 *  - credentials are secret REFERENCES only (`managed-secret`); there is no
 *    literal path for callback secrets. The catalog secretId is the stable
 *    reference id;
 *  - reserved header names (authorization, signing/content/host/length,
 *    hop-by-hop) can never be configured;
 *  - credential-bearing auth requires an administrator-approved destination
 *    set (exact https origins, optional path prefixes);
 *  - OAuth2 extension names may not override reserved grant fields.
 */
import type {
  CallbackAuthMethod,
  CallbackConfiguredHeader,
  CallbackDestinationAuthorization,
  CallbackMode,
  CallbackOAuth2Auth,
  CallbackSecretRef,
  ProfileCallbackPolicy,
} from '@/lib/api';

export const CALLBACK_MODES: readonly CallbackMode[] = ['notification_only', 'notification_with_result'];
export const CALLBACK_AUTH_METHODS: readonly CallbackAuthMethod[] = [
  'none',
  'configured_headers',
  'oauth2_client_credentials',
];

/** Reserved header names mirrored from the frozen contract (no server import). */
export const RESERVED_CALLBACK_HEADERS: readonly string[] = [
  'authorization',
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'x-du-signature',
  'x-du-timestamp',
  'x-du-delivery-id',
];

export const OAUTH2_RESERVED_FORM_FIELDS: readonly string[] = [
  'grant_type',
  'client_id',
  'client_secret',
  'scope',
  'audience',
  'resource',
];

export const CALLBACK_MAX_HEADERS = 8;
export const CALLBACK_MAX_OAUTH2_EXTENSIONS = 8;

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const EXTENSION_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface CallbackHeaderDraft {
  name: string;
  secretId: string | null;
  prefix: string;
  /** Seeded from a stored policy: render configured/Replace/Clear. */
  configuredOnServer: boolean;
  /** Operator pressed Replace; show the editor even when configured. */
  replacing: boolean;
}

export interface CallbackExtensionDraft {
  name: string;
  value: string;
}

export interface CallbackDraft {
  /** True once the operator explicitly configured this policy. */
  touched: boolean;
  mode: CallbackMode;
  authMethod: CallbackAuthMethod;
  headers: CallbackHeaderDraft[];
  tokenUrl: string;
  clientId: string;
  clientSecretId: string | null;
  /** Seeded from a stored policy: render configured/Replace/Clear. */
  clientSecretConfiguredOnServer: boolean;
  clientSecretReplacing: boolean;
  clientAuthMethod: 'client_secret_basic' | 'client_secret_post';
  scope: string;
  audience: string;
  resource: string;
  extensions: CallbackExtensionDraft[];
  tokenLifetimeSeconds: string;
  approvedOrigins: string;
  allowedPathPrefixes: string;
  forceReferenceOnly: boolean;
}

/**
 * Catalog purposes a callback credential may be resolved for. The purpose
 * filter keeps an operator from selecting a secret the resolver would deny at
 * delivery time (SC-02 `PURPOSE_DENIED`).
 */
export const CALLBACK_SECRET_PURPOSES = {
  header: 'profile.callback_header',
  oauth2ClientSecret: 'profile.callback_oauth2_client_secret',
} as const;

export function emptyCallbackDraft(): CallbackDraft {
  return {
    touched: true,
    mode: 'notification_only',
    authMethod: 'none',
    headers: [{ name: '', secretId: null, prefix: '', configuredOnServer: false, replacing: false }],
    tokenUrl: '',
    clientId: '',
    clientSecretId: null,
    clientSecretConfiguredOnServer: false,
    clientSecretReplacing: false,
    clientAuthMethod: 'client_secret_basic',
    scope: '',
    audience: '',
    resource: '',
    extensions: [],
    tokenLifetimeSeconds: '',
    approvedOrigins: '',
    allowedPathPrefixes: '',
    forceReferenceOnly: false,
  };
}

/** Parse the frozen read shape into a draft; null when the shape is unusable. */
export function callbackPolicyFromRead(value: unknown): CallbackDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const policy = value as Partial<ProfileCallbackPolicy>;
  if (policy.version !== 1 || typeof policy.mode !== 'string' || !CALLBACK_MODES.includes(policy.mode)) return null;
  const auth = policy.auth;
  if (typeof auth !== 'object' || auth === null || !CALLBACK_AUTH_METHODS.includes(auth.method)) return null;
  const draft = emptyCallbackDraft();
  draft.touched = true;
  draft.mode = policy.mode;
  draft.authMethod = auth.method;
  draft.forceReferenceOnly = policy.forceReferenceOnly === true;
  const destination = policy.destination;
  if (destination !== undefined && destination !== null) {
    draft.approvedOrigins = destination.approvedOrigins.join('\n');
    draft.allowedPathPrefixes = (destination.allowedPathPrefixes ?? []).join('\n');
  }
  if (auth.method === 'configured_headers') {
    draft.headers = auth.headers.map((header: CallbackConfiguredHeader) => ({
      name: header.name,
      secretId: header.secretRef.ref,
      prefix: header.prefix ?? '',
      configuredOnServer: true,
      replacing: false,
    }));
    if (draft.headers.length === 0) {
      draft.headers = [{ name: '', secretId: null, prefix: '', configuredOnServer: false, replacing: false }];
    }
  }
  if (auth.method === 'oauth2_client_credentials') {
    draft.tokenUrl = auth.tokenUrl;
    draft.clientId = auth.clientId;
    draft.clientSecretId = auth.clientSecretRef.ref;
    draft.clientSecretConfiguredOnServer = true;
    draft.clientAuthMethod = auth.clientAuthMethod;
    draft.scope = auth.scope ?? '';
    draft.audience = auth.audience ?? '';
    draft.resource = auth.resource ?? '';
    draft.tokenLifetimeSeconds = auth.tokenLifetimeSeconds === undefined ? '' : String(auth.tokenLifetimeSeconds);
    draft.extensions = Object.entries(auth.extensions ?? {}).map(([name, extensionValue]) => ({ name, value: extensionValue }));
  }
  return draft;
}

function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function secretRef(secretId: string): CallbackSecretRef {
  return { kind: 'managed-secret', ref: secretId };
}

/**
 * Client-side validation with the same rules the frozen schema enforces.
 * Returns human-readable messages; the server remains the authority.
 */
export function validateCallbackDraft(draft: CallbackDraft): string[] {
  const errors: string[] = [];
  if (!CALLBACK_MODES.includes(draft.mode)) errors.push('mode is invalid');
  if (!CALLBACK_AUTH_METHODS.includes(draft.authMethod)) errors.push('auth method is invalid');

  if (draft.authMethod === 'configured_headers') {
    const names = new Set<string>();
    const active = draft.headers.filter((header) => header.name.trim().length > 0 || header.secretId !== null);
    if (active.length === 0) errors.push('configured_headers requires at least one header');
    // F5: count only real entries; blank draft rows must not trip the limit.
    if (active.length > CALLBACK_MAX_HEADERS) errors.push(`at most ${CALLBACK_MAX_HEADERS} headers`);
    for (const header of active) {
      const name = header.name.trim();
      if (!HEADER_NAME_RE.test(name)) errors.push(`header '${name}' is not a valid HTTP token`);
      if (RESERVED_CALLBACK_HEADERS.includes(name.toLowerCase())) errors.push(`header '${name}' is reserved and cannot be configured`);
      if (names.has(name.toLowerCase())) errors.push(`duplicate header '${name}'`);
      names.add(name.toLowerCase());
      if (header.secretId === null) errors.push(`header '${name}' needs a secret reference`);
      if (header.prefix.length > 64) errors.push(`header '${name}' prefix is too long`);
      // F5: the frozen contract rejects CR/LF/NUL in a prefix; fail here so the
      // operator sees the field error instead of a server 422.
      if (/[\r\n\0]/.test(header.prefix)) {
        errors.push(`header '${name}' prefix must not contain CRLF or NUL characters`);
      }
    }
  }

  if (draft.authMethod === 'oauth2_client_credentials') {
    if (!draft.tokenUrl.startsWith('https://')) errors.push('token URL must be https');
    try {
      const url = new URL(draft.tokenUrl);
      if (url.protocol !== 'https:') errors.push('token URL must be https');
    } catch {
      errors.push('token URL must be a valid URL');
    }
    if (draft.clientId.trim().length === 0) errors.push('client id is required');
    // F5: mirror the frozen contract bounds so long values fail in the editor.
    if (draft.clientId.length > 256) errors.push('client id must be at most 256 characters');
    if (draft.scope.length > 512) errors.push('scope must be at most 512 characters');
    if (draft.audience.length > 512) errors.push('audience must be at most 512 characters');
    if (draft.resource.length > 512) errors.push('resource must be at most 512 characters');
    if (draft.clientSecretId === null) errors.push('client secret reference is required');
    if (draft.tokenLifetimeSeconds.trim().length > 0) {
      const lifetime = Number(draft.tokenLifetimeSeconds);
      if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 86_400) {
        errors.push('token lifetime must be an integer between 1 and 86400 seconds');
      }
    }
    if (draft.extensions.length > CALLBACK_MAX_OAUTH2_EXTENSIONS) {
      errors.push(`at most ${CALLBACK_MAX_OAUTH2_EXTENSIONS} extension parameters`);
    }
    const seenExtensions = new Set<string>();
    for (const extension of draft.extensions) {
      const name = extension.name.trim();
      if (!EXTENSION_NAME_RE.test(name)) errors.push(`extension '${name}' must be lowercase snake_case`);
      if (OAUTH2_RESERVED_FORM_FIELDS.includes(name)) errors.push(`extension '${name}' is reserved and cannot be overridden`);
      if (seenExtensions.has(name)) errors.push(`duplicate extension '${name}'`);
      seenExtensions.add(name);
      if (extension.value.length > 1024) errors.push(`extension '${name}' value is too long`);
    }
  }

  if (draft.authMethod !== 'none') {
    const origins = splitLines(draft.approvedOrigins);
    if (origins.length === 0) errors.push('credential-bearing callbacks require at least one approved origin');
    if (origins.length > 16) errors.push('at most 16 approved origins');
    for (const origin of origins) {
      try {
        const url = new URL(origin);
        if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
          errors.push(`origin '${origin}' must be an exact https origin`);
        }
      } catch {
        errors.push(`origin '${origin}' is not a valid URL`);
      }
    }
    const prefixes = splitLines(draft.allowedPathPrefixes);
    if (prefixes.length > 16) errors.push('at most 16 allowed path prefixes');
    for (const prefix of prefixes) {
      if (!prefix.startsWith('/')) errors.push(`path prefix '${prefix}' must start with /`);
    }
  }

  return errors;
}

/**
 * Build the frozen policy object. Returns null when the draft is invalid; the
 * caller surfaces the validation messages instead of sending a partial body.
 */
export function buildCallbackPolicy(draft: CallbackDraft): ProfileCallbackPolicy | null {
  if (validateCallbackDraft(draft).length > 0) return null;
  const destination: CallbackDestinationAuthorization | undefined = draft.authMethod === 'none'
    ? undefined
    : {
        approvedOrigins: splitLines(draft.approvedOrigins),
        ...(splitLines(draft.allowedPathPrefixes).length > 0
          ? { allowedPathPrefixes: splitLines(draft.allowedPathPrefixes) }
          : {}),
      };

  let auth: ProfileCallbackPolicy['auth'];
  if (draft.authMethod === 'none') {
    auth = { method: 'none' };
  } else if (draft.authMethod === 'configured_headers') {
    auth = {
      method: 'configured_headers',
      headers: draft.headers
        .filter((header) => header.name.trim().length > 0 && header.secretId !== null)
        .map((header) => ({
          name: header.name.trim(),
          secretRef: secretRef(header.secretId as string),
          ...(header.prefix.length > 0 ? { prefix: header.prefix } : {}),
        })),
    };
  } else {
    const extensions: Record<string, string> = {};
    for (const extension of draft.extensions) {
      if (extension.name.trim().length > 0) extensions[extension.name.trim()] = extension.value;
    }
    const oauth2: CallbackOAuth2Auth = {
      method: 'oauth2_client_credentials',
      grantType: 'client_credentials',
      tokenUrl: draft.tokenUrl.trim(),
      clientId: draft.clientId.trim(),
      clientSecretRef: secretRef(draft.clientSecretId as string),
      clientAuthMethod: draft.clientAuthMethod,
      ...(draft.scope.trim().length > 0 ? { scope: draft.scope.trim() } : {}),
      ...(draft.audience.trim().length > 0 ? { audience: draft.audience.trim() } : {}),
      ...(draft.resource.trim().length > 0 ? { resource: draft.resource.trim() } : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
      ...(draft.tokenLifetimeSeconds.trim().length > 0
        ? { tokenLifetimeSeconds: Number(draft.tokenLifetimeSeconds) }
        : {}),
    };
    auth = oauth2;
  }

  return {
    version: 1,
    mode: draft.mode,
    auth,
    ...(destination !== undefined ? { destination } : {}),
    ...(draft.forceReferenceOnly ? { forceReferenceOnly: true } : {}),
  };
}
