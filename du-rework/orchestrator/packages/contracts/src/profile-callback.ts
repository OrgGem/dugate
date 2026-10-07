/**
 * CB-01 — Profile callback contracts (freeze).
 *
 * Defines the versioned callback policy, outbound authentication config and
 * result projection a profile/endpoint revision may carry. Delivery execution
 * (scheduling, encryption, at-least-once retry, token cache) belongs to CB-02
 * (webhook/result) and CB-03 (auth/secret/egress); this module only freezes
 * the shapes, bounds and security decisions those owners must implement.
 *
 * Security invariants encoded here:
 *  - destination URLs and OAuth2 token URLs are adjudicated for private/
 *    loopback/metadata targets via the shared `ip-policy` adjudicator;
 *  - credential-bearing delivery requires an administrator-approved exact
 *    origin (and optional path prefixes) — a caller-supplied host never gets
 *    profile secrets;
 *  - sensitive/reserved headers cannot be overridden, duplicated, injected
 *    (CRLF) or unbounded;
 *  - secrets are managed references only (write-only, never values);
 *  - inline results are bounded; larger/binary content travels as authenticated
 *    result/download references with an explicit expiry — never truncation,
 *    raw storage URLs or embedded bytes.
 */
import { z } from 'zod';
import { WebhookEventTypes } from './public-api';
import { DESTINATION_DENIED, adjudicateUrlDestination } from './ip-policy';

export const CALLBACK_POLICY_VERSION = 1 as const;

/** Bounds (bytes unless stated). Delivery cannot inline more than this. */
export const CALLBACK_MAX_INLINE_RESULT_BYTES = 256 * 1024;
export const CALLBACK_MAX_DELIVERY_BODY_BYTES = 512 * 1024;
export const CALLBACK_MAX_ARTIFACT_DESCRIPTORS = 32;
export const CALLBACK_MAX_HEADERS = 8;
export const CALLBACK_MAX_HEADER_VALUE_LENGTH = 1024;
export const CALLBACK_MAX_OAUTH2_EXTENSIONS = 8;

/** Modes: absent policy keeps the legacy notification-only delivery. */
export const CALLBACK_MODES = ['notification_only', 'notification_with_result'] as const;
export const CallbackModeSchema = z.enum(CALLBACK_MODES);
export type CallbackMode = z.infer<typeof CallbackModeSchema>;
export const CALLBACK_DEFAULT_MODE: CallbackMode = 'notification_only';

/** Redirects are denied for authenticated callback/token requests. */
export const CALLBACK_REDIRECTS_ALLOWED = false;

/**
 * Headers a callback policy may never set/override. `authorization` is owned by
 * the auth mode, the signing/content/host/length headers by the dispatcher, and
 * the hop-by-hop set by the transport.
 */
export const RESERVED_CALLBACK_HEADERS = [
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
] as const;

const RESERVED_HEADER_SET = new Set<string>(RESERVED_CALLBACK_HEADERS);
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_NAME_SCHEMA = z.string().min(1).max(128).regex(HTTP_TOKEN_RE, {
  message: 'header name must be an HTTP token',
});
const HEADER_VALUE_SCHEMA = z
  .string()
  .min(1)
  .max(CALLBACK_MAX_HEADER_VALUE_LENGTH)
  .refine((value) => !/[\r\n\u0000]/.test(value), { message: 'header value must not contain CR/LF/NUL' });

export function isReservedCallbackHeader(name: string): boolean {
  return RESERVED_HEADER_SET.has(name.trim().toLowerCase());
}

/**
 * A managed secret reference. Write-only: the value never round-trips, is
 * never logged, and is resolved by the secrets owner (Vault-backed) at
 * delivery time with rotation/revocation semantics.
 */
export const CallbackSecretRefSchema = z
  .object({
    kind: z.literal('managed-secret'),
    /** Opaque reference resolved by the secrets owner; no value, no URL. */
    ref: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, {
      message: 'secret ref must be an opaque managed path',
    }),
  })
  .strict();
export type CallbackSecretRef = z.infer<typeof CallbackSecretRefSchema>;

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

export const CallbackAuthMethodSchema = z.enum(['none', 'configured_headers', 'oauth2_client_credentials']);
export type CallbackAuthMethod = z.infer<typeof CallbackAuthMethodSchema>;

/** One secret-bearing header. `prefix` is a fixed literal (e.g. "Bearer "). */
export const ConfiguredHeaderSchema = z
  .object({
    name: HEADER_NAME_SCHEMA,
    secretRef: CallbackSecretRefSchema,
    prefix: z.string().max(64).refine((value) => !/[\r\n\u0000]/.test(value), {
      message: 'prefix must not contain CR/LF/NUL',
    }).optional(),
  })
  .strict();

export const ConfiguredHeadersAuthSchema = z
  .object({
    method: z.literal('configured_headers'),
    headers: z.array(ConfiguredHeaderSchema).min(1).max(CALLBACK_MAX_HEADERS),
  })
  .strict();
export type ConfiguredHeadersAuth = z.infer<typeof ConfiguredHeadersAuthSchema>;

/** Non-secret extra header (OAuth2 only); same reserved-name fence. */
export const AdditionalHeaderSchema = z
  .object({ name: HEADER_NAME_SCHEMA, value: HEADER_VALUE_SCHEMA })
  .strict();

/** Extension form parameter reserved keys — never override the grant itself. */
export const OAUTH2_RESERVED_FORM_FIELDS = [
  'grant_type',
  'client_id',
  'client_secret',
  'scope',
  'audience',
  'resource',
] as const;
const OAUTH2_RESERVED_FORM_SET = new Set<string>(OAUTH2_RESERVED_FORM_FIELDS);

function httpsUrlWithPublicDestination(field: string) {
  return z
    .string()
    .url()
    .max(2048)
    .superRefine((value, ctx) => {
      if (!value.startsWith('https://')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be https`, path: [] });
        return;
      }
      const decision = adjudicateUrlDestination(value);
      if (decision.kind === 'DENIED') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} destination is not allowed`,
          path: [],
          params: { code: DESTINATION_DENIED, reason: decision.reason },
        });
      }
    });
}

export const OAuth2ClientCredentialsAuthSchema = z
  .object({
    method: z.literal('oauth2_client_credentials'),
    grantType: z.literal('client_credentials'),
    /** HTTPS token endpoint; SSRF-adjudicated and redirect-denied at runtime. */
    tokenUrl: httpsUrlWithPublicDestination('tokenUrl'),
    clientId: z.string().min(1).max(256),
    clientSecretRef: CallbackSecretRefSchema,
    clientAuthMethod: z.enum(['client_secret_basic', 'client_secret_post']),
    scope: z.string().min(1).max(512).optional(),
    audience: z.string().min(1).max(512).optional(),
    resource: z.string().min(1).max(512).optional(),
    /** Bounded provider extensions; reserved grant fields are rejected. */
    extensions: z
      .record(
        z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, { message: 'extension names are lowercase snake_case' }),
        z.string().max(1024).refine((value) => !/[\r\n\u0000]/.test(value), { message: 'extension value must not contain CR/LF/NUL' }),
      )
      .refine((value) => Object.keys(value).length <= CALLBACK_MAX_OAUTH2_EXTENSIONS, {
        message: `at most ${CALLBACK_MAX_OAUTH2_EXTENSIONS} extension parameters`,
      })
      .optional(),
    additionalHeaders: z.array(AdditionalHeaderSchema).max(CALLBACK_MAX_HEADERS).optional(),
    /** Lifetimes are never assumed: when omitted the token is per-delivery. */
    tokenLifetimeSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .strict();
export type OAuth2ClientCredentialsAuth = z.infer<typeof OAuth2ClientCredentialsAuthSchema>;

function validateHeaderList(
  headers: readonly { name: string }[],
  path: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    const name = header.name.trim().toLowerCase();
    if (isReservedCallbackHeader(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index, 'name'],
        message: `header '${header.name}' is reserved and cannot be configured`,
      });
    }
    if (seen.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index, 'name'],
        message: `duplicate header '${header.name}'`,
      });
    }
    seen.add(name);
  });
}

/**
 * Union-level refinement (a discriminated union cannot carry per-branch
 * `superRefine`): validates header lists for both credential-bearing branches.
 */
export const CallbackAuthSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('none') }).strict(),
    ConfiguredHeadersAuthSchema,
    OAuth2ClientCredentialsAuthSchema,
  ])
  .superRefine((auth, ctx) => {
    if (auth.method === 'configured_headers') {
      validateHeaderList(auth.headers, 'headers', ctx);
      return;
    }
    if (auth.method === 'oauth2_client_credentials') {
      for (const key of Object.keys(auth.extensions ?? {})) {
        if (OAUTH2_RESERVED_FORM_SET.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['extensions', key],
            message: `'${key}' is reserved and cannot be overridden`,
          });
        }
      }
      validateHeaderList(auth.additionalHeaders ?? [], 'additionalHeaders', ctx);
    }
  });
export type CallbackAuth = z.infer<typeof CallbackAuthSchema>;

/* ------------------------------------------------------------------ */
/* Destination authorization                                           */
/* ------------------------------------------------------------------ */

/**
 * Administrator-approved destinations. `origins` are exact `https://host[:port]`
 * origins (no path/query/fragment); optional path prefixes further narrow them.
 * A credential-bearing delivery whose URL is outside this set is refused before
 * any credential is attached.
 */
export const CallbackApprovedOriginSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        (url.pathname === '' || url.pathname === '/') &&
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  }, { message: 'approved origin must be an exact https origin (no path, query, userinfo or fragment)' });

export const CallbackDestinationAuthorizationSchema = z
  .object({
    approvedOrigins: z.array(CallbackApprovedOriginSchema).min(1).max(16),
    /** Optional path prefixes; when set, the URL path must start with one. */
    allowedPathPrefixes: z
      .array(z.string().min(1).max(512).regex(/^\//, { message: 'path prefix must start with /' }))
      .max(16)
      .optional(),
  })
  .strict();
export type CallbackDestinationAuthorization = z.infer<typeof CallbackDestinationAuthorizationSchema>;

export interface CallbackDestinationDecision {
  readonly kind: 'ALLOWED' | 'DENIED';
  readonly reason?: string;
}

/**
 * Decide whether a caller-supplied callback URL may receive credentials under
 * the approved destination set. Credential-bearing auth always requires an
 * approval entry; `none` auth still requires a publicly routable HTTPS URL.
 */
export function authorizeCallbackDestination(
  url: string,
  auth: CallbackAuth,
  authorization: CallbackDestinationAuthorization | null | undefined,
): CallbackDestinationDecision {
  const adjudicated = adjudicateUrlDestination(url);
  if (adjudicated.kind === 'DENIED') {
    return { kind: 'DENIED', reason: adjudicated.reason };
  }
  if (auth.method === 'none') {
    return { kind: 'ALLOWED' };
  }
  if (authorization == null || authorization.approvedOrigins.length === 0) {
    return { kind: 'DENIED', reason: 'credential-bearing callback requires approved destinations' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'DENIED', reason: 'callback URL is not parseable' };
  }
  if (parsed.protocol !== 'https:') {
    return { kind: 'DENIED', reason: 'credential-bearing callback must be https' };
  }
  const origin = parsed.origin;
  if (!authorization.approvedOrigins.includes(origin)) {
    return { kind: 'DENIED', reason: 'callback origin is not approved' };
  }
  const prefixes = authorization.allowedPathPrefixes;
  if (prefixes !== undefined && prefixes.length > 0 && !prefixes.some((prefix) => parsed.pathname.startsWith(prefix))) {
    return { kind: 'DENIED', reason: 'callback path is outside the approved prefixes' };
  }
  return { kind: 'ALLOWED' };
}

/* ------------------------------------------------------------------ */
/* Result projection (notification_with_result)                        */
/* ------------------------------------------------------------------ */

/** Oversize/expiry handling: omit inline, never truncate, never embed bytes. */
export const CALLBACK_RESULT_OMIT_REASONS = [
  'OVERSIZED',
  'EXPIRED',
  'UNAVAILABLE',
  'ENCRYPTED_ONLY',
] as const;
export const CallbackResultOmitReasonSchema = z.enum(CALLBACK_RESULT_OMIT_REASONS);
export type CallbackResultOmitReason = z.infer<typeof CallbackResultOmitReasonSchema>;

/**
 * Reference to an authenticated result/download endpoint. Carries no bytes and
 * no storage URL; `expiresAt` comes from the artifact's existing expiry and
 * manual resend cannot extend it.
 */
export const CallbackArtifactDescriptorSchema = z
  .object({
    artifactId: z.string().uuid(),
    role: z.string().min(1).max(128),
    fileName: z.string().min(1).max(512).optional(),
    mimeType: z.string().min(1).max(255).optional(),
    sizeBytes: z.number().int().min(0),
    download: z
      .object({
        path: z.string().min(1).max(1024).regex(/^\/api\/v1\//, { message: 'download path must be a relative platform API path' }),
        expiresAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();
export type CallbackArtifactDescriptor = z.infer<typeof CallbackArtifactDescriptorSchema>;

/**
 * The `notification_with_result` delivery body: the existing event envelope
 * fields plus a versioned structured result and artifact descriptors. `state`
 * covers success/failure/cancel/timeout; `omitted` explains a withheld inline
 * result. `result` is either the authorized result projection or null.
 */
export const CallbackResultEnvelopeSchema = z
  .object({
    projectionVersion: z.literal('1'),
    eventType: z.enum(WebhookEventTypes),
    operationId: z.string().uuid(),
    state: z.string().min(1).max(64),
    occurredAt: z.string().datetime(),
    result: z.record(z.string(), z.unknown()).nullable(),
    resultOmitted: CallbackResultOmitReasonSchema.optional(),
    artifacts: z.array(CallbackArtifactDescriptorSchema).max(CALLBACK_MAX_ARTIFACT_DESCRIPTORS),
    /** Present when the platform result API exposed usage at terminal time. */
    usage: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.result !== null && envelope.resultOmitted !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resultOmitted'], message: 'omitted reason requires result=null' });
    }
    if (envelope.result === null && envelope.resultOmitted === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resultOmitted'], message: 'result=null requires an explicit omission reason' });
    }
  });
export type CallbackResultEnvelope = z.infer<typeof CallbackResultEnvelopeSchema>;

/** Byte bound helper used by the projection writer before sending. */
export function callbackInlineResultWithinBound(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= CALLBACK_MAX_INLINE_RESULT_BYTES;
}

/* ------------------------------------------------------------------ */
/* Policy, precedence and admission snapshot                           */
/* ------------------------------------------------------------------ */

export const ProfileCallbackPolicySchema = z
  .object({
    version: z.literal(CALLBACK_POLICY_VERSION),
    mode: CallbackModeSchema,
    auth: CallbackAuthSchema,
    /** Required whenever auth is credential-bearing. */
    destination: CallbackDestinationAuthorizationSchema.nullable().optional(),
    /** Per-policy opt-out of inline results (references only) — never truncation. */
    forceReferenceOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.auth.method !== 'none' && (policy.destination == null || policy.destination.approvedOrigins.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'credential-bearing auth requires an approved destination set',
      });
    }
  });
export type ProfileCallbackPolicy = z.infer<typeof ProfileCallbackPolicySchema>;

/**
 * Endpoint policy overrides the profile default; both absent preserves the
 * legacy notification-only behavior (submission callback URL, HMAC signature,
 * existing event envelope).
 */
export function resolveEffectiveCallbackPolicy(input: {
  readonly profileDefault?: ProfileCallbackPolicy | null;
  readonly endpointPolicy?: ProfileCallbackPolicy | null;
}): ProfileCallbackPolicy | null {
  return input.endpointPolicy ?? input.profileDefault ?? null;
}

/**
 * Admission-time pin recorded on the operation/profile snapshot. Identity and
 * revision are copied, so a later publish/rollback cannot silently retarget an
 * already-admitted delivery.
 */
export const ProfileCallbackPolicySnapshotSchema = z
  .object({
    tenantId: z.string().uuid(),
    businessId: z.string().min(1).max(128),
    businessVersion: z.string().min(1).max(128),
    profileName: z.string().min(1).max(256),
    /** Endpoint identity: canonical action or endpointSlug, per contract owner. */
    endpointKey: z.string().min(1).max(256),
    profileRevision: z.number().int().min(1),
    policy: ProfileCallbackPolicySchema,
  })
  .strict();
export type ProfileCallbackPolicySnapshot = z.infer<typeof ProfileCallbackPolicySnapshotSchema>;
