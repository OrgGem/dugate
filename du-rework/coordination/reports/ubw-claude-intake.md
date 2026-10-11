# UBW intake — Claude Code coordinator, 2026-10-08

Status: **INTAKE / ANALYSIS ONLY**. No implementation dispatched from this receipt.
Nothing here is IMPLEMENTED, VERIFIED or ACCEPTED. No gate ticked. No commit/push.

- Scope accepted: `D:/Git/dugate/du-rework` only; legacy root read-only for cross-reference; `nocobase` out of scope.
- Canonical plan: `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` (UBW-00..08).
- Handoff proof: `coordination/reports/ubw-orca-handoff-2026-10-08.md` — orca response `677025ac-38f7-...`, durable request `c452fe06-d30e-4097-8444-fa16e6320782`, stage `input_accepted`, **`turn_started` NOT OBSERVED**. This receipt is the observed completion of that intake leg.
- Role held: single dispatcher per `COORDINATOR-CONTRACT.md`. Plan/metadata/receipt/dispatch-prompt writes only. No product code, no tests, no builds, no DB/S3/Vault mutation by me.
- No second dispatcher created. No running work cancelled.

## 1. Live roster at intake (read-only observation)

`orca terminal list`, worktree `D:/Git/dugate` group `21d1b352-5289-467a-9069-84f9797ab18c`:

| Terminal | Identity/state | Doing now | UBW collision risk |
|---|---|---|---|
| `term_19edcad8-dcd8-4930-a6a2-24f5f8be5bd8` | claude, connected | this coordinator session | none — it is me |
| `term_4bca69af-a9d5-40f4-8dac-2edb1853dbac` | qwen_2, connected | R5 legacy 5xx investigation — **DONE** (receipt landed 22:59) | none |
| `term_16fef1c3-69ea-42e7-a4aa-c2684a064bad` | qwen, connected | independent test leg — **DONE** (receipt landed 22:58) | none |
| `term_ca784044-5910-4d55-9d41-36c1d90fcf24` | Codex, connected | 503-guard tests — **DONE**, idle | none |
| `term_43f85ccc-f868-4ec5-b9df-7a64325b1ce6` | Codex, connected | Usage tenantId fix — ran, tree restored, uncommitted | none |
| `term_6bd1346d-2135-4b91-9fd8-0df7570e1b90` | Codex, connected | tenant selection — ran, idle | none |
| `term_cefb27a0` / `term_169a5da5` / `term_8a432ae3` / `term_f1c5a1d1` | OC, connected | CR06-04/CR06-05 (sessionRef preservation, service identity enforcement) — live | **medium** — touch orchestrator runtime/identity; UBW-02 overlaps conceptually |
| `term_8bfe6adc` / `term_3bdf6f85` | dsh-TUI, connected | verification legs — finished prior packets, idle | none |
| `term_1062621c-d2b1-47a5-9085-390c99a2554a` | Codex, connected | UI clarification for business active/deactivate — working (user conversation) | **high** — same problem statement as UBW; do not pre-empt |
| `term_f4f7687d-c8ed-4b8f-acde-09b74ade10d3` | Codex, connected | tenant/admin update — ran, idle | none |

**Collision verdict:** UBW-00 (source read-only) and UBW-01 (design metadata) are safe to run now — they touch no product file. UBW-02+ must not start until the CR06 OC lanes and `term_1062621c` settle, because UBW-02 owns startup registration in the same registry/runtime area.

## 2. Live leases that constrain UBW (verified on disk this intake)

From `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` — all six rows still read **RUNNING** (lines 37-42). Live path leases:

| WFA row | Owner role | Exact leased paths | UBW overlap |
|---|---|---|---|
| WFA-02 | API subagent | `services/orchestrator/src/compat/`, `src/http/routes/public.ts`, `src/http/route-context.ts`, `src/app/bootstrap/`, `src/modules/operations/` | **UBW-04** directly — do not start |
| WFA-03 | Runtime subagent | new `packages/contracts/src/legacy-workflow*.ts`, new `modules/workflow-schemas/`, dedicated migration, `businesses/document-core/src/pipelines/workflows/schema/` | **UBW-04/UBW-06** directly — do not start |
| WFA-04 | Verification subagent | `tests/workflow-api/` only, product read-only | UBW-07 must use a different path prefix |
| WFA-05 | Codex integration | no overlapping source edit while lease active | blocks UBW-02..06 integration |
| WFA-06 | Codex docs | `docs/06-public-api.md`, `docs/39-legacy-parity-contract.md`, generator + generated `docs/21-openapi.json` | UBW-08 docs lease must wait |

Also live and dirty in the shared tree (do not blanket-freeze, do not revert — COORDINATOR-CONTRACT §Role): `AGENTS.md`, `du-rework/docs/04-data-state.md`, `du-rework/coordination/*`, `apps/admin-web/src/features/{api-docs,operations,overview,usage}/*`, `apps/admin-web/src/app-shell/app-shell.tsx`, `apps/admin-web/src/lib/api/client.ts`, `packages/observability/src/log-metadata.ts`, `services/orchestrator/src/{app/admin/bff/handle,compat/legacy-host-adapter,db/migrations,modules/runtime/runtime}.ts`, plus test files `artifact-read-authorization`, `enc-meta-sentinel-runtime-refs`, `legacy-http-mount`, `public-upload-encryption-gateway`, `rv01-loopback-http-offline`.

**The admin-web `lib/api/client.ts` and `app-shell.tsx` are already dirty** — these are exactly the files a UBW-03 catalog-UI packet would need. That lease must be established explicitly against the current writer, not assumed.

## 3. State reconciliation — SPECIFIED / IMPLEMENTED / VERIFIED / ACCEPTED

| Plan area | State | Evidence held today |
|---|---|---|
| UBW plan itself | **SPECIFIED** | `PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md`; user-authored |
| UBW-00 inventory | **NOT STARTED** | no receipt |
| UBW-01 UI design | **NOT STARTED** | no receipt |
| UBW-02..06 | **NOT STARTED** | no receipts |
| UBW-07/08 | **NOT STARTED** | no receipts |
| WFA-01..06 | **RUNNING**, none VERIFIED/ACCEPTED | ledger lines 37-42 |
| legacy 503-guard test pins | **IMPLEMENTED + independently VERIFIED (2 lanes agree)** | `fix-legacy-503-guard-tests-2026-10-09.md`; `verify-legacy-ara-INDEPENDENT-DSH-…`; `verify-legacy-ara-INDEPENDENT-QWEN-…`; my own run 35/35 exit 0 |
| `artifact-read-authorization` 5 RED | **OPEN RED**, awaiting owner decision | my run 5 failed/85 passed/90 total exit 1; DSH + QWEN legs both reproduce; `draft-decision-artifact-read-auth-2026-10-09.md` proposes fixes B/C, **not applied** |
| R5 legacy 5xx detail leak | **investigated — LOW, latent** | `investigate-legacy-5xx-detail-leak-2026-10-09.md`: real mechanism, no concrete trigger path today; redact-only-`>=500` proposed, **not implemented** |

I do not tick any of the above. Coordinator-only.

## 4. Open decisions requiring the user's call (blocking UBW-01 finalisation)

**D-UBW-1 — Process binding: alias target or first-class node type?**
Plan §3.7 correctly defers this, but the UI IA cannot be finalised without it. A process name either (a) resolves to one business/version/action or workflow revision as an **alias**, or (b) becomes a node type in the workflow graph. These produce different screens and different API shapes. Recommend (a) alias-first — it preserves the legacy `disbursement` / `lc-checker` / `doc-compare` names and `schemaSlug` compatibility with the least new surface.

**D-UBW-2 — Cross-business workflow in V1?**
Plan §3.8 proposes same-business multi-action as mandatory acceptance and cross-business as optional pending a runtime audit. Confirm: V1 acceptance = two actions **of the same business**, cross-business explicitly deferred with a named follow-up. My reading of `workflow-engine` supports same-business only being safe without new executor semantics.

**D-UBW-3 — Profile model: extend DTO, or adapter?**
Plan §3.9 flags this. Extending the profile DTO/storage to carry workflow revision + per-node config is cleaner long-term but risks the frozen contract and the live WFA-03 lease on contracts. An adapter keeps contracts frozen but creates two profile concepts. Needs an owner call before UBW-06 packets.

**D-UBW-4 — Δ-DEV-03 gate authority for UBW-05.**
`workflows-screen.tsx` is disabled-by-banner citing Δ-DEV-03. Who may lift it, and does the Workflow API need to be ACCEPTED first? UBW-05 must not self-enable.

**D-UBW-5 — Worker management depth for V1.**
Plan §3.6 says drain/resume/revoke only open if a real control protocol + acknowledgement exists. Does that protocol exist in the current runtime, or is V1 read-only (list + health + capacity + registration guidance) with control actions deferred?

**D-UBW-6 — Which lanes take UBW-02 and UBW-06?**
Both need owner splitting before dispatch (SDK owner vs runtime owner for UBW-02; profile UI owner vs backend admission owner for UBW-06). The plan explicitly says Claude must pick from the live roster and write dispatch proof first. I have not picked, because the CR06 lanes are still live and the split point is exactly their territory.

## 5. Recommended packet order (metadata only — nothing dispatched yet)

| Order | Packet | Gate to dispatch |
|---|---|---|
| 1 | **UBW-00** inventory + decision matrix, read-only, own receipt | now — disjoint from every live lease |
| 2 | **UBW-01** UI IA / wireframes / journey, plan metadata only | after UBW-00; needs D-UBW-1/2 answered |
| 3 | **UBW-02** startup registration + worker registry contracts | WFA-05 clear + CR06 lanes idle + D-UBW-5 |
| 4 | **UBW-04** process binding + workflow contracts | WFA-03 lease released; needs D-UBW-1 |
| 5 | **UBW-03** Workers/Businesses UI + BFF | UBW-02 DTO + explicit `client.ts`/`app-shell.tsx` lease |
| 6 | **UBW-05** workflow builder UI | UBW-04 contracts + D-UBW-2/4 |
| 7 | **UBW-06** workflow-bound profile UI + admission | UBW-05 + D-UBW-3 |
| 8 | **UBW-07** independent functional/browser verification | per slice ready; own test paths |
| 9 | **UBW-08** independent UI verdict + docs | UBW-07 green + WFA-06 docs lease released |

Note the plan's own numbering lists UBW-03 before UBW-04; I have ordered 04 before 03 because 03 depends on 02's DTO and the catalog UI is useless until the process/workflow contract exists. Flagging as a deviation for the coordinator to accept or reverse.

## 6. Explicit non-actions this intake

- No UBW dispatch sent. No packet written to `dispatch-specs/`.
- No `plans`/`tasks` file created or edited; the UBW plan is unchanged.
- No product/test/doc source edited. No build or test run as coordinator except the read-only test verification legs recorded above, which were dispatched to owners.
- No gate ticked, no plan row advanced, no lease claimed or released.
- No commit, no `git add`, no push. `.env.live` not read.
- No running agent cancelled or re-tasked. `term_1062621c` (user conversation on exactly this problem) left untouched.