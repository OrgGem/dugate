# Receipt — PC-R02 workflow execution pins

| Field | Value |
|---|---|
| Packet | `FOLLOWUP-PC-R02` (P1) — *Pin selected workflows into preview, admission, and execution* |
| Worker | `dsh_3` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Status | **COMPLETE** — tsc 0, new suite 6/6 live, negative control fails 1/6 without the digest, 118 regression tests green |
| Affects | PC-03, PC-05, PC-07, PC-09 |
| Files changed | `src/modules/operations/submission.ts`, `tests/pc-r02-workflow-execution-pins.test.ts` (new) |

**Tóm tắt (VI).** Trước đây một workflow function trong group chỉ pin `workflowRevision` — một con số — trong khi fingerprint hard-code `workflow: null` và admission không hề compile/persist danh tính workflow. Nay preview **resolve** đúng revision trong `legacy_workflow_schemas` (fail-closed nếu retired/không tồn tại), đưa `{slug, revision, digest}` vào fingerprint, và admission chuyển pin đã resolve vào cùng compiler mà đường legacy dùng, nên operation ghi đủ `workflow_schema_slug/revision/digest` + carrier recipe đã seal. Retry vốn đã copy đủ ba cột và reseal carrier — nay có test chứng minh.

---

## 1. What was missing

A group member of kind `workflow` carries `functionId` (the workflow slug), `action` and
`workflowRevision`. Three gaps:

1. `buildProfileResolutionV2` passed `workflow: null` to `computeResolutionFingerprint`,
   so the registry snapshot was not part of the preview contract at all.
2. `submitProfileV2` never forwarded a `workflowSchemaPin`, so
   `compileAdmittedWorkflowPin` never ran: `operations.workflow_schema_*` stayed NULL and
   no sealed recipe carrier was written.
3. Nothing re-checked that the pinned revision was still **active** at preview/admission
   time. The save-time check (PC-03) only covers the moment the group is saved.

## 2. The fix

**Preview / resolution.** When `pin.kind === 'workflow'` and a revision is pinned:

- resolve `legacy_workflow_schemas` by `(tenantId, slug = pin.functionId, revision)`;
- a retired row (`SCHEMA_NOT_ACTIVE`) or a row that fails its own integrity check
  (`SCHEMA_INVALID`) is a `409 PROFILE_CHANGED` carrying the registry code, so on-call can
  tell "retired" from "tampered";
- the resolved pin is folded into the fingerprint as `workflow: { slug, revision, digest }`;
- a member with **no** revision (legacy v1 semantics, recorded as NULL) keeps
  `workflow: null` — it pins no registry snapshot, and inventing one would be worse.

**Admission.** `submitProfileV2` forwards the resolved pin as `workflowSchemaPin`, which is
exactly the input the legacy workflow path already feeds to `compileAdmittedWorkflowPin`.
That one function validates the digest against the canonical bytes, compiles the connector
recipe pins, and the existing insert writes `workflow_schema_slug`,
`workflow_schema_revision`, `workflow_schema_digest` and the sealed
`connector_recipe_pins_ref`.

**Retry.** No change was needed: `retryOperation` already copies the three workflow columns
verbatim and opens/re-seals `connector_recipe_pins_ref` under the new operation id inside the
universal lock order. The packet's job there was to prove it, which the suite now does.

### Two digests, on purpose

The **registry** digest (catalog row) is a function of the workflow body and is what the
fingerprint carries. The **compiled** digest persisted on the operation is
`compileWorkflowSchemaPinDigest(schema + recipe pins)` — the value the runtime validates
against the compiled carrier. They are different values by design; asserting equality would
have been wrong, and the test asserts the compiled digest's shape plus stability across retry.

## 3. Verification (actually run)

Environment: Node v22.23.3, disposable `postgres:16-alpine` on host port 55440 (removed after
the run), migrations `0001…0071` applied by the real runner.

| # | Command (cwd `services/orchestrator`) | Result |
|---|---|---|
| 1 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0** |
| 2 | `DU_LIVE_INFRA=1 jest --config jest.config.cjs tests/pc-r02-workflow-execution-pins.test.ts` | **6 passed** |
| 3 | `jest --config jest.unit.config.cjs` on the 6 retry/v2 suites | **61 passed, 6 suites** |
| 4 | `DU_LIVE_INFRA=1` on `profile-control-plane-cutover` + `pc-r08-managed-replay-reauth` + this suite | **57 passed, 3 suites** |
| 5 | Negative control: `workflow: workflowRef` → `workflow: null` | **1 failed, 5 passed** — exactly the digest test |

Test #5 is the one that matters. My first version of the digest test pinned the member to a
**new revision**, which changes `function.workflowRevision` and therefore the fingerprint
even with `workflow: null` — the negative control passed, proving the test proved nothing.
The rewritten version simulates a registry rewrite **at the same revision** (new sealed
envelope, new canonical digest, same revision number), which is the only case where the
digest is the sole variable. With `workflow: null` that test now fails.

Suite coverage:

1. preview resolves the snapshot; a same-revision body rewrite changes the fingerprint;
2. submit persists slug, revision and a compiled digest on the operation, and the recipe
   carrier is a sealed envelope;
3. retiring the revision between preview and submit → `409 PROFILE_CHANGED`, zero rows;
4. moving the member to another revision invalidates the stale preview;
5. retry copies all three pins onto the new operation;
6. an ordinary endpoint function keeps `workflow: null` and NULL columns.

## 4. Deviations and limitations (explicit)

| # | Item | Note |
|---|---|---|
| 1 | The fixture workflow declares **no connector node**, so the compiled recipe map is empty (still sealed and written). | A connector-bearing workflow also requires `options.connectorManagement` plus explicit profile connector pins; that composition is PC-06/PC-R05 territory and was not exercised here. |
| 2 | The fingerprint carries the registry digest, not the compiled one. | Recipe-pin drift alone (same body, moved connector revision) therefore does not move the fingerprint. Recipe pins are pinned per admission by the compile step; wiring them into the fingerprint belongs with PC-R05. |
| 3 | The denial code for a bad registry row is `PROFILE_CHANGED` with the registry code in the message. | The dispatch asked for `PROFILE_CHANGED` for retired/changed; `SCHEMA_INVALID` (tampered row) reuses it because the operator answer is identical: re-preview. |
| 4 | Legacy members with a NULL `workflowRevision` keep `workflow: null`. | Deliberate: v1 semantics are preserved rather than guessing a revision at preview time. |

## 5. Files changed

| File | In lease? | Change |
|---|---|---|
| `src/modules/operations/submission.ts` | yes | registry import; workflow resolution in the v2 builder; fingerprint field; `workflowPin` on the built result; forward into `submitProfileV2` |
| `tests/pc-r02-workflow-execution-pins.test.ts` | yes (new) | 6 live tests, offline crypto fixture, registry provisioning |
| `src/modules/operations/retry.ts` | leased but **unchanged** | already copies the pins and re-seals the carrier; proven by test 5 |

`profiles.ts`, `profile-groups.ts`, `api-keys.ts` and the frontend are untouched.
