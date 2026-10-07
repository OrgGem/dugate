import { z } from 'zod';

import { ProfileEndpointPolicySchema, ProfileRevisionSchema } from './profile-policy';

/**
 * P730-ADMIN-MUTATE (Δ7 ruling (A)) — the WRITE command shape for the three
 * `profile.*` dispatcher actions.
 *
 * Why this file exists instead of widening `ProfileUpsertParamsSchema`: that schema is
 * frozen and pinned by `tests/profile-policy.test.ts` ("dispatcher action params mirror
 * the frozen BFF wire"), and it carries only `ProfileKey` — (businessId,
 * businessVersion, profileName). That triple cannot name a row: `profile_bindings` is
 * keyed (profile_id, revision), `profile_id` is `randomUUID()` per createRevision
 * (`modules/profiles/profiles.ts:353`), and a mutation primitive needs `apiKeyHash`
 * plus `action` (`profiles.ts:345-351`). Adding fields in place would break every
 * pinned parse, so the mutation contract is a SEPARATE, additive command schema.
 *
 * Kept deliberately separate from `ProfileUpsertParamsSchema` rather than replacing it:
 * the read/detail wire stays exactly as the shell fetcher expects, and only the write
 * path learns the extra identity. When the closure (T-API-01 detail read) reveals the
 * key, the UI switches to these params and the old schema can be deprecated by the
 * contract owner on its own schedule.
 */

/** 64-hex sha256 — the shape `api_keys.hash` stores and `hashApiKey` produces. */
const API_KEY_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * A profile is bound to exactly one API key; nothing in (businessId,
 * businessVersion, profileName) selects it. The caller therefore names the key,
 * either by its stored hash (the shape `apikey.bind-profile` already uses, so a
 * hash is never a secret here — it is the lookup key, not a credential) or by the
 * row id the api-key read surfaces.
 *
 * `.strict()` on both object arms so `{ apiKeyId, apiKeyHash }` together is a 422
 * rather than a silently preferred arm.
 *
 * `.transform()` (Δ7-A ruling): both WIRES keep parsing unchanged, and the
 * OUTPUT is one tagged ref `{kind:'id'|'hash'}` so the dispatcher leaf never
 * re-implements the arm discrimination. Non-breaking: every pinned
 * `safeParse(...).success` assertion on the old shapes still holds.
 */
export const ApiKeyRefSchema = z
  .union([
    z.object({ apiKeyId: z.string().uuid() }).strict(),
    z.object({ apiKeyHash: z.string().regex(API_KEY_HASH_RE) }).strict(),
  ])
  .refine(
    (ref) => Object.keys(ref).length === 1,
    { message: 'apiKey must carry exactly one of apiKeyId or apiKeyHash' },
  )
  .transform(
    (ref): ApiKeyRef =>
      'apiKeyId' in ref
        ? { kind: 'id', id: ref.apiKeyId }
        : { kind: 'hash', hash: ref.apiKeyHash },
  );
export type ApiKeyRef =
  | { kind: 'id'; id: string }
  | { kind: 'hash'; hash: string };

const ProfileCommandKeyShape = {
  businessId: z.string().min(1),
  businessVersion: z.string().min(1),
  profileName: z.string().min(1),
  apiKey: ApiKeyRefSchema,
  /**
   * The manifest action this profile governs (`profiles_bindings.action`). Optional
   * because the BFF path carries only (b, v, n); when omitted the dispatcher resolves
   * it as `profileName`, the documented legacy identity ("a profileName is an
   * endpoint slug", profile-policy.ts:41-46). Sending it explicitly is how a client
   * targets a slug whose action differs.
 */
  action: z.string().min(1).optional(),
};

/**
 * `profile.upsert` command. `policy` mandatory (even `{}`), same rule as the frozen
 * `ProfileUpsertParamsSchema`: an upsert with no policy would append a revision nobody
 * can read. `expectedRevision` optional — a blind first save stays legal (R-12).
 */
export const ProfileUpsertCommandSchema = z
  .object({ ...ProfileCommandKeyShape, expectedRevision: ProfileRevisionSchema.optional(), policy: ProfileEndpointPolicySchema })
  .strict();
export type ProfileUpsertCommand = z.infer<typeof ProfileUpsertCommandSchema>;

/**
 * `profile.publish` command. `expectedRevision` REQUIRED: publish is a CAS move, a
 * publish without it lets two operators overwrite each other (T-DB-02).
 */
export const ProfilePublishCommandSchema = z
  .object({ ...ProfileCommandKeyShape, expectedRevision: ProfileRevisionSchema })
  .strict();
export type ProfilePublishCommand = z.infer<typeof ProfilePublishCommandSchema>;

/**
 * `profile.rollback` command. `targetRevision` required (the revision to re-pin);
 * `expectedRevision` optional so a rollback may be issued from a stale view when the
 * operator explicitly declines to CAS. Rollback MOVES THE POINTER only.
 */
export const ProfileRollbackCommandSchema = z
  .object({ ...ProfileCommandKeyShape, targetRevision: ProfileRevisionSchema, expectedRevision: ProfileRevisionSchema.optional() })
  .strict();
export type ProfileRollbackCommand = z.infer<typeof ProfileRollbackCommandSchema>;

/**
 * The three actions this slice now dispatches. Narrower than
 * `PROFILE_DISPATCHER_ACTIONS` (which also lists prompt-override.* and assignment.*,
 * still pending: prompt-override needs the same-tx seam and assignment is gated on
 * T-AUTH-03/VFY-LOCAL).
 */
export const PROFILE_MUTATION_ACTIONS = [
  'profile.upsert',
  'profile.publish',
  'profile.rollback',
] as const;
export type ProfileMutationAction = (typeof PROFILE_MUTATION_ACTIONS)[number];

