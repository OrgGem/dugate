# Independent phase 2 source review

Reviewer: `/root/requirements_alignment`, `gpt-6.1-sol`, high, read-only. Scope: frozen profile backend, backend recovery/lock repairs and SDK single-flight repair. Verdict: profile **CHANGES NEEDED**; core repairs **APPROVED at source level**, live gates open.

1. **P1 selector overlap race.** `profile-groups.ts:160-163,236-254` uses a shared selected-key lock and unlocked overlap absence check. Concurrent groups can both commit the same key/business/version/action selector. `profiles.ts:416-419` orders and LIMITs to one binding, silently selecting one policy and shadowing the other successful save. Serialize check plus membership/pointer writes across group and legacy mutations. A barrier regression must yield exactly one success and one conflict with no loser residue.
2. **P1 child ownership bypass.** `http/routes/admin.ts:396-405` directly calls `profiles.createRevision` with supplied profileId; `profiles.ts:469-532` does not reject group ownership. External child mutation changes public behavior and invalidates the group snapshot. Reject transactionally and verify unchanged pointers, snapshots and memberships.
3. **P2 business availability race.** `admin-read/business-functions.ts:94-99` reads enabled without a catalog lock. Save/rollback can validate, lose a race to disable, and still commit. Hold availability locks through materialization/commit and barrier-test both paths.
4. **P2 existing key rotation compatibility.** Rotation copies memberships and revokes the historical key (`admin-actions/dispatcher.ts:1126,1150-1159`), but group read/local visibility and rollback depend on that historical key being ACTIVE (`profile-groups.ts:367-375,731`; `self-service.ts:347-360`). Resolve current replacement membership authorization without new credentials or rewriting immutable snapshots. Verify public submission and assigned-user read/edit/rollback after rotation, plus unauthorized denials.

Core source repairs reviewed: recovery/dispatcher overwrite envelope deliveryId from durable row authority; fresh claim checks newest dispatch/continuation under task lock; exact-ID lost-ACK replay remains live/pin-compatible; explicit digest heartbeat no longer locks immutable version first; SDK reserves task before claim and holds it through raw handler and report settlement, including abort-ignoring handlers. No new core finding. Worker identity helper has no diff.

Other profile source checks passed: full-set transactional materialization/removal, group CAS, tenant key checks, declared function/action/endpoint coherence, required connector slots and visible ACTIVE connectors. Strict policy rejects policy.endpointSlug; generic functions use declared manifest actions.

Owner logs reviewed: profile 22 tests, backend repair 48 tests, SDK guard 16 tests passed. Reviewer ran no tests/builds. Independent migration/race/BullMQ/UI/template/full-suite gates remain distinct; source approval is not deployment proof.

All four profile findings assigned to `/root/profile_groups_backend` for Luna max repair; product source leases serialized with frozen core owners. Primary only records coordination evidence.

Authorization scope clarification: rotation restores READ for the already assigned/granted local user and edit/rollback for an already authorized editor/admin. Existing local USER group mutation denial remains. Review acceptance wording does not authorize a new local write capability.
