import json, os, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T14:25:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"


def orca_run(args, timeout=240):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": (r.stdout or r.stderr or "")[:300]}


w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

SPEC_STORAGE = (
    "Your connector/profile-admin journey receipt is SETTLED - I verified the plaintext authSecret insert "
    "(ext-connections/route.ts:101), the precise crypto.ts attribution (helper has NO plaintext fallback; the "
    "plain-JSON branch lives in the CALLER profile-endpoints/route.ts:53-57), prompt precedence "
    "_prompt > promptOverride > defaultPrompt (prompt-resolver.ts:29-35), and parseConnectionSteps handling "
    "both legacy string[] and ConnectionStep[] (profile-resolver.ts:128-141). Accurate. New read-only task, "
    "same scope: characterize the LEGACY STORAGE ENGINE + FILE CACHING - upload admission and validation, "
    "Local vs S3-compatible backend selection, FileCache MD5 dedup, and the 7-day cleanup - against the rework "
    "artifact model. This is the one remaining surface no receipt has covered with file:line (retention "
    "receipt mentioned FileCache only in passing; comp03 covered the input-bridge wire, not the storage engine). "
    "Answer with file:line: "
    "(1) UPLOAD ADMISSION: lib/upload.ts - the 300MB max (config or hard-coded?), the macro/office-file "
    "rejection, path-traversal protection, and where the size check happens relative to full buffering. "
    "lib/upload-helper.ts - what it adds. Cite each. "
    "(2) BACKEND SELECTION: lib/config.ts + the storage layer - how Local vs S3/MinIO/R2 is chosen (env "
    "var? AppSetting?), what happens when S3 is configured but a call fails - any fallback to Local, or "
    "fail-closed? Cite the code. "
    "(3) FILECACHE DEDUP: schema Prisma model FileCache (md5Hash, s3Key, size, refCount) - exact columns and "
    "unique constraints from prisma/schema.prisma; the write path that increments refCount and the read path "
    "that reuses a cache hit; is the dedup scoped per-tenant/key or instance-global? MUST-NOT-REPLICATE if a "
    "cache hit can serve another tenant's bytes - cite file:line and STOP. "
    "(4) CLEANUP: lib/cleanup.ts + lib/cleanup-scheduler.ts - the 7-day auto-delete rule, what exactly gets "
    "deleted (uploads only? outputs? FileCache rows?), how refCount gates deletion, what happens to an "
    "Operation whose file is deleted mid-run or after terminal, and whether cleanup touches S3 objects. "
    "(5) OPERATION FILE FIELDS: submit.ts file save - operations.fileUrl/filePaths and output storage key "
    "(file:// vs s3:// vs local path shapes) - state the exact stored value format for each backend, since "
    "COMP clients poll operations and the stored file shape is part of the wire. "
    "(6) REWORK COUNTERPART: with file:line, what rework has today - modules/artifacts (blobs, storage keys, "
    "content hash, artifact grants from modules/grants), migrations/0001 artifacts table columns, "
    "server.ts blob routes (GET/PUT) and public download; is there any dedup/cache equivalent, any scheduled "
    "retention for artifact bytes, any S3 backend, or is everything still Postgres bytea? State plainly which "
    "legacy behaviors have NO rework counterpart (S3 backend, MD5 dedup/refCount, 7-day cleanup) and which "
    "rework behaviors are not in legacy (artifact role labels, grant tokens with expiry, READY-immutable "
    "state). Do not propose any fix. "
    "HARD CHECKS: (1) characterization only - do NOT propose fixes, config changes, or new storage schemes; "
    "(2) every claim carries file:line; write 'not found' rather than guessing; (3) anything "
    "MUST-NOT-REPLICATE carries file:line and STOP; (4) standing security constraints apply to rework "
    "counterparts: encryption fail-closed no bypass, tenant-fenced access, never serve another tenant's "
    "artifact - label violations MUST-NOT-REPLICATE with file:line; (5) do NOT restate balance, spend or "
    "cost numbers; (6) no gate ticks, no COMP row changes. Path reminder: legacy storage code is at the REPO "
    "TOP LEVEL (lib/upload.ts, lib/cleanup*.ts, lib/db or lib/storage helpers, prisma/schema.prisma), NOT "
    "under app/lib/**; rework is du-rework/services/orchestrator/src/modules/artifacts/** and "
    "migrations/0001_platform_v1.sql. Limits: READ-ONLY with source; write only your own new report file "
    "du-rework/coordination/reports/codex-legacy-storage-engine-filecache-2026-10-01.md; no source edits; no "
    "test runs; no commits."
)

s = orca_run(["terminal", "send", "--terminal",
              "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
              "--text", SPEC_STORAGE, "--enter", "--json"])
print("[SEND] ctx_task_legacy_storage_filecache -> ok=%s" % s.get("ok"), flush=True)
t = orca_run(["orchestration", "task-create", "--spec", SPEC_STORAGE,
              "--task-title",
              "COMP/ORCH-PAR read-only: legacy storage engine + FileCache dedup + 7-day cleanup vs rework artifacts",
              "--display-name",
              "COMP/ORCH-PAR read-only: legacy storage engine + FileCache vs rework artifacts",
              "--run", RUN, "--json"])
task = (t.get("result") or {}).get("task") or {}
tid = task.get("id")
print("[TASK-CREATE] -> ok=%s id=%s" % (t.get("ok"), tid), flush=True)

key = "ctx_task_legacy_storage_filecache"
if key not in disp:
    disp[key] = collections.OrderedDict()
e = disp[key]
e["taskId"] = tid
e["terminalHandle"] = "term_b2d08e87-4435-4323-8e14-b58fa1a6729b"
e["lastObservedAt"] = NOW
e["lastProgressAt"] = NOW
e["transcriptCursor"] = ""
e["consecutiveUnfinishedChecks"] = 0
e["lastNudgeAt"] = None
e["blocker"] = None
e["status"] = "running"
e["receipt"] = None
e["supervised"] = True

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(x["status"] for x in disp.values())
print("watch-state total", len(disp), dict(c))
