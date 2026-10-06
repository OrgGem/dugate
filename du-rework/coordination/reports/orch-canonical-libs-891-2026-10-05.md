# ORCH-CANONICAL-LIBS-891 — receipt (qwen_1, 2026-10-05)

Task task_8edd16dbe85d. Lease honoured exactly: NEW isolated output
migration-candidates/orchestrator/** + this receipt. packages/**, services/**,
businesses/**, root lockfile, shared docs = READ-ONLY and untouched.

## (1) Sources read

- tasks/USER-AUTHORIZED-LIBS-MIGRATION-2026-10-05.md — user authorization
  2026-10-05: local implementation now, isolated candidate approved; RPK-00 wait
  SUPERSEDED but RPK-00 stays a tracking task; original source must remain
  available until candidates verify; export from an explicit allowlist WITH
  hashes INCLUDING untracked classified product files; no HEAD-only, no
  blanket dirty-tree copy; unclassified needs an owner decision.
- docs/40-du-platform-architecture.md:90,102 — max three repo types, default two
  (Orchestrator + Worker); Connector inside the Orchestrator repo as its own
  service/image; RPK-00 sequencing.
- coordination/reports/codex-arch-unblock-migration-2026-10-05.md — section C
  lease for 891: scaffold candidate-local manifests first, classify consumers,
  copy classified source ONLY from the pinned 889 inventory and verify hashes,
  build with worker siblings absent, no in-place canonical source edits.

## (2) Canonical ownership confirmed in this candidate

Inside migration-candidates/orchestrator/:
- packages/contracts, connector-client, document-kit, egress, observability =
  the canonical contract/shared reference source the task names.
- packages/worker-sdk is ALSO present, and deliberately so: services/orchestrator
  imports worker-sdk in 6 files, so excluding it would break the candidate build.
  Its canonical reference lives with the Orchestrator repo while each WORKER gets
  its own local versioned copy (WORKER-TEMPLATE-PILOT-890 owns that side).
- NO fourth SDK/Shared repo was created. This candidate IS the Orchestrator repo.

## (3) Candidate-local scaffold (891 owns these files)

- package.json  — name du-orchestrator-candidate, workspaces packages/* + services/*
  ONLY (the copied original also listed businesses/*, tests/*, apps/* — removed).
- pnpm-workspace.yaml — packages/* + services/*, same pnpm overrides.
- tsconfig.base.json — copied verbatim from the pinned inventory.
- tsconfig.candidate.json — candidate-local type-check config with paths mapping
  @du/contracts|connector-client|document-kit|egress|observability|worker-sdk to the
  candidate packages, so workspace resolution never leaves the candidate.
- scripts/build.cjs — resolves the TypeScript TOOLCHAIN from an installed store,
  runs `tsc --noEmit -p tsconfig.candidate.json` inside the candidate.
- scripts/verify-isolation.cjs — static proof (below).
- scripts/copy-from-inventory.cjs — copies ONLY allowlisted paths from the 889 TSV.

## (4) Export from the pinned inventory + hash verification

Command: node migration-candidates/orchestrator/scripts/copy-from-inventory.cjs
Scope: files present in
coordination/reports/raw/rpk-inventory-freeze-889-2026-10-05.tsv
filtered to packages/**, services/orchestrator/**, services/connector/** and the
root manifests (package.json, pnpm-lock.yaml, pnpm-workspace.yaml,
tsconfig.base.json, .npmrc, Dockerfile, .dockerignore).

- files copied: 717
- SHA-256 mismatches against the 889 allowlist: 0
- TypeScript/TSX files now inside the candidate: 616
- businesses/ directory present inside the candidate: NO (never created)

Untracked product source was NOT excluded: the 889 freeze proved 243 product
files exist only in the working tree, and the export is driven by that allowlist,
not by git.

## (5) Isolation proof — worker siblings ABSENT, no outside-repo path

node scripts/verify-isolation.cjs => Exit Code 0:
  tsFiles: 616
  outsideRepoRelativeImports: 0
  workerSiblingReferences: 0
  businessesDirPresent: false

And the decisive evidence from the build itself:
  Cannot find module "@du/..."  -> 0
  Cannot find module (any)        -> 25, all third-party (zod and friends)

Every workspace package import resolved INSIDE the candidate. Nothing needed a
worker sibling or a path outside the candidate tree.

## (6) Build result — honest, NOT green

node scripts/build.cjs => tsc from
node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc
- Type-check completed and REPORTED 146 type errors.
- Error split: 25 unresolved modules, ALL third-party (zod and peers); the
  remaining ~121 are implicit-any / TS7006 / TS7053 cascades that exist because
  zod types are absent.
- 0 of them are about a missing worker sibling or an outside-repo path.

So the isolation claim is PROVEN, and the build is BLOCKED ON DEPENDENCY
INSTALL, not on missing sibling source. The candidate has no node_modules, so
third-party types are unavailable. This is the exact risk the design doc names:
"Build tu su chua chac offline: xac minh nguon/cache dependencies/toolchain".

To close it: a candidate-local `pnpm install --frozen-lockfile` inside
migration-candidates/orchestrator (its own lockfile copy is already present),
then re-run build.cjs. That step needs an install window and was not performed
here — no network/cache guarantee exists in this lane.

## (7) Connector kept as its own service/image INSIDE the candidate

services/connector/** copied into the candidate as a separate workspace member
with its own package.json, and pnpm-workspace.yaml lists services/* so both
services build separately. No Connector repo was created, and the Runtime was
not split out.

## File counts / hashes / exit codes (item 6)

| item | value |
|---|---|
| files copied from the 889 allowlist | 717 |
| SHA-256 mismatches vs allowlist | 0 |
| candidate TS/TSX files | 616 |
| outside-repo relative imports | 0 |
| worker-sibling references | 0 |
| businesses/ present in candidate | false |
| copy-from-inventory.cjs exit | 0 |
| verify-isolation.cjs exit | 0 |
| build.cjs (tsc --noEmit) exit | 2 (146 errors) |
| unresolved @du/* modules | 0 |
| unresolved third-party modules | 25 |

## Open items for the coordinator (not closed here)

1. Candidate-local dependency install + green type-check (needs an install
   window). Until then the candidate is isolated but not build-proven end to end.
2. 76 UNCLASSIFIED files from 889 still have no owner decision. None were copied
   into the candidate (apps/admin-web + 4 top-level jest configs) — confirm that
   exclusion is intended, since admin-web is Portal UI that the target topology
   places inside the Orchestrator repo.
3. contracts <-> worker-sdk cycle (19 files / 1 file) from 889 is still uncut and
   now reproduced inside the candidate.
4. Codex arch decision B (signed management identity, HS256 JWT with exp from the
   token, no process-lifetime cache) is NOT implemented here: it needs main.ts /
   composition / management-store edits, which are outside this lease and belong
   to the single serialized identity owner.
5. No commit, no push, no prod cutover, no remote repo created.
