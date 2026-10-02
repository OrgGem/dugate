"""Coordinator cycle 2026-10-01 19:35 - step 1: settle the five finished lanes.

Read-only vs source; only coordination/agent-watch-state.json is written.
"""
import json

W = r"D:/Git/dugate/du-rework/coordination/agent-watch-state.json"
NOW = "2026-10-01T19:35:00+07:00"

SETTLES = {
    "ctx_task_p901_registration": {
        "receipt": "codex-p9-01-disbursement-2026-10-01.md",
        "summary": (
            "D1 done 18:32 (re-verified by coordinator this cycle). F1/F2/F3/F6 implemented: manifest "
            "disbursement action + connector slots, getWorkflowRecipe + 5 stable step keys, "
            "input-normalizer discriminators, index.ts barrel. Honest verification: focused 4/4, "
            "tsc 0 x2, full suite 845 passed / 6 failed vs baseline 810/4 => lane honestly reported "
            "2 NEW reds it caused itself (manifest.test.ts six-action exact array; a test.failing that "
            "now passes). Root cause found by coordinator review: manifest declares action 'disbursement' "
            "but NOT its handler kind; manifest-validator.ts:97-105 short-circuits on the 'root' "
            "catch-all, so an unregistered action validates; sdk-consumer.test.ts:127-140 hard-codes "
            "the 7 legacy kinds and requires a function handler per kind. => D3 dispatched to same lane "
            "(add kind + real handler + honest assertion updates; no weakening). F8 fixtures untouched."
        ),
    },
    "ctx_task_fix_compat_header_denylist": {
        "receipt": "codex-comp03b-d2-decoder-hardening-2026-10-01.md",
        "summary": (
            "D2 done 18:28. FORBIDDEN_IDENTITY_HEADERS extended with 'authorization' + body-style "
            "spellings (apiKeyId/api_key_id/xApiKeyId/apiKey/api_key/xApiKey/x_api_key/tenantId/"
            "tenant_id/userId/user_id/createdByUserId/created_by_user_id/role); assertNoUnknownQueryFields "
            "called before field collection, allow-list {sync} for object + URLSearchParams, evidence "
            "lib/endpoints/runner.ts:70,229 reads only 'sync'; orphan 'type' on generate now tested. "
            "Tests 46/46 exit 0 (was 43), tsc orchestrator 0. Hard checks re-read by coordinator: "
            "x-api-key-id still rejected, x-api-key accepted but never copied to output, no ADMIN/bearer "
            "fallback, serializer + routes untouched, no gate tick. Settled."
        ),
    },
    "ctx_task_p9_03_doc_compare": {
        "receipt": "codex-p9-03-doc-compare-2026-10-01.md",
        "summary": (
            "P9-03 done 18:32. doc-compare workflow module: 33/33 tests green on 3 consecutive runs, "
            "tsc 0, resume-from-checkpoint covered, 5 self-found bugs documented (preamble flush, NFKD "
            "combining marks, trailing re-emit, positional pairing, accepted-review infinite wait). "
            "Coordinator re-read: runChunk (DocCompareRuntime, doc-compare.ts:93, required at :454) still "
            "has NO production implementation, and no host references advanceDocCompare anywhere outside "
            "the module index - registration and runner both missing. => D4 dispatched for the runner; "
            "manifest/recipe registration stays in D3's file set (single writer). All gates NO-GO, no commit."
        ),
    },
    "ctx_task_rv0101_boot_encryption": {
        "receipt": "qwen-platform.md",
        "summary": (
            "RV01-01 report final at prompt, 57-row append-only ledger, last3=[56,57,58], no dups, "
            "leases intact (main.ts bfbd87cf = only the other lane's +7/-1 admin-shell baseline, "
            "server.ts 22afb2ff clean), no commit/gate/nocobase-10. Acceptance 4-7 NOT met, blockers "
            "recorded honestly: (A) ORDERING - main.ts never passes metadataEncryption / "
            "publicUploadEncryption into createApp, so metadataCrypto is undefined and every control-plane "
            "column silently stays plaintext - the exact fail-open RV01-01 exists to close; "
            "(B) INFRA - no MinIO (:9000) and no Vault dev (:8200) in this env. => RV01-02 (#8 wiring, "
            "runnable offline incl. negative boot matrix row 7) dispatched to this same lane; coordinator "
            "now authorises ONE lane-namespaced MinIO + ONE Vault dev container for acceptance 4-6 after "
            "row 7 is green. row 7 alone proves nothing about the live seam."
        ),
    },
    "ctx_task_rv0103_worker_artifact_encryption": {
        "receipt": "qwen-admin.md",
        "summary": (
            "RV01-03 report final at prompt, lease explicitly RELEASED. 4 fail-closed defects fixed in "
            "lease (missing seam in single-PUT and multipart, seal returns full envelope, read 503 when "
            "marker missing / encryptionRequired, 5 MiB cap enforced during read). Evidence: worker-sdk "
            "pnpm test 23 suite / 645 pass / 0 skip exit 0 (baseline 22/628), lint 0, orchestrator "
            "typecheck 0, artifact-read-decrypt-offline 28/28. orchestrator test:unit exit 1 (5 suites) - "
            "7 admin-shell failures proven pre-existing by A/B revert, oidc-boot = EADDRINUSE only. "
            "Open by design: envelope carrier, chunked AAD ordering (sealStream fails closed SEAL_FAILED "
            "rather than inventing an artifactId), ADR-18 wire profile - all three are unsigned wire "
            "decisions = user blocker, NOT handed out. Isolation used: DB du_test_rv0103_enc + Redis db 15 "
            "prefix du:rv0103:, cleaned up. No live S3/Vault case ran."
        ),
    },
}


def main() -> None:
    with open(W, encoding="utf-8") as fh:
        state = json.load(fh)
    dispatches = state["dispatches"]
    for key, payload in SETTLES.items():
        row = dispatches[key]
        row["status"] = "settled"
        row["lastObservedAt"] = NOW
        row["settledAt"] = NOW
        row["consecutiveUnfinishedChecks"] = 0
        row.pop("lastNudgeAt", None)
        row["receipt"] = payload["receipt"]
        row["summary"] = payload["summary"]
    with open(W, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1)
    from collections import Counter
    counts = Counter(row.get("status") for row in dispatches.values())
    print("settled rows:", len(SETTLES), "->", dict(counts))


if __name__ == "__main__":
    main()