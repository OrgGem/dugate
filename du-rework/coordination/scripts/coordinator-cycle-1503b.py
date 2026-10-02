import json, sys, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T15:03:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

key = "ctx_task_legacy_storage_filecache"
e = disp.get(key)
if e is None:
    print("MISSING", key)
else:
    e["status"] = "settled"
    e["receipt"] = (
        "du-rework/coordination/reports/codex-legacy-storage-engine-filecache-2026-10-01.md | "
        "C4 VERIFIED against real code: (1) SCHEMA: prisma/schema.prisma DOES NOT EXIST (ls ENOENT - "
        "confirmed myself); legacy schema is Drizzle lib/db/schema.ts + drizzle/0000_violet_franklin_storm.sql. "
        "FileCache table = id, md5Hash UNIQUE not-null, s3Key, fileName, mimeType, size, refCount default 1, "
        "createdAt, lastAccessedAt - NO tenant/apiKey column - confirmed schema.ts:150-165 (I read this). "
        "(2) MUST-NOT-REPLICATE VERIFIED BY ME: dedup upserts on globally-unique md5Hash only "
        "(onConflictDoUpdate target fileCaches.md5Hash, set refCount+1) and returns the EXISTING canonical "
        "s3Key into the new operation's file metadata with zero tenant scoping - so tenant A uploading the "
        "same bytes as tenant B gets B's object key back (dedup.ts:29-58,63-77 I read this). Unique-race path "
        "also updates WHERE md5Hash=md5 only. No tenant predicate anywhere. (3) ADMISSION: MAX_FILE_SIZE "
        "hard-coded 300 MiB in upload.ts (NOT env/AppSetting); a SEPARATE 100 MiB MAX_FILE_SIZE_BYTES in "
        "config.ts:7 is NOT imported by the upload validator - upload.ts:8,59-67 + config.ts:7. .docm rejected "
        "before the extension allowlist. Upload-helper sanitizes basename + NFC + strips control/special chars, "
        "rejects resolved path outside UPLOAD_DIR (upload-helper.ts:11-19,40-42; local-backend.ts:12-19). "
        "Aggregate MAX_TOTAL_UPLOAD_SIZE default 1 GiB, summed AFTER each save, attempts to delete on overflow "
        "(submit.ts:186-188,233-245). (4) BACKEND SELECTION: AppSetting s3_bucket truthy -> S3 else Local "
        "(storage/index.ts:14-50, cached per-process); comment claims endpoint-selection but code branches on "
        "bucket; NO local fallback when S3 fails - S3 catch deletes the key and rethrows; submit maps known "
        "storage errors to 503, others 500 (s3-backend.ts:79-87; submit.ts:192-219). (5) CLEANUP TIMING CORRECTED "
        "- '7-day cleanup' is MISLEADING: operation-associated files sweep at 24 hours (createdAt < cutoff, "
        "filesDeleted=false, deletedAt IS NULL, NO operation-state predicate so an old RUNNING row IS selected) "
        "(cleanup.ts:17,40-54); the 168h/7-day setting s3_cache_ttl_hours applies ONLY to FileCache rows with "
        "refCount<=0 AND lastAccessedAt < cutoff (settings.ts:102-109; cleanup.ts:127-150). Scheduler = 6-hour "
        "interval, first run 10s after startup (cleanup-scheduler.ts:11-32). In-flight op selected by cleanup "
        "-> input objects removed, filesDeleted=true set, row NOT marked terminal; engine later downloadToTempFile "
        "fails -> pipeline FAILED path (cleanup.ts:79-111; engine.ts:187-210,450-465). Terminal op: row/result NOT "
        "deleted; outputContent still served; outputFilePath-only download 404 'Output file has been cleaned up' "
        "(download/route.ts:20-27,37-58,60-111). (6) OPERATION FILE FIELDS: Operation has filesJson/outputContent/"
        "outputFilePath, NO fileUrl/filePaths column (schema.ts:10-42). Uploaded-file JSON entry = filename, "
        "canonical key in BOTH path and s3Key, mime, size, fileCacheId, md5; key = <operationId>/<sanitizedName> "
        "(no file:// or s3:// prefix) (submit.ts:222-230; upload-helper.ts:40-58). Remote URL entry = path:'', url, "
        "isRemoteUrl:true, size 0 (submit.ts:248-280). NO non-null production assignment to outputFilePath found - "
        "completion writes outputContent, external-api sets outputFilePath:undefined - so exact persisted "
        "output-path format per backend = NOT FOUND (engine.ts:397-414; external-api.ts:50,216). (7) REWORK "
        "COMPARISON: artifacts carry tenant_id + purpose (input/output/intermediate/session), SHA-256 integrity, "
        "STAGING->READY immutability with method-scoped expiring grants (0001:128-144; 0003:6-13; 0008:1-8; "
        "artifacts.ts:108-125,140-146,261-290,419-425,462-485). Storage backend = postgres DEFAULT with s3 "
        "constraint (0013:1-20; server.ts:336-347) + configured S3 facade requiring versioned objects + "
        "tenant/artifact/version/size/sha validation (s3-storage-facade.ts:146-150,184-215). NO rework "
        "counterpart for MD5 dedup / FileCache.refCount / 7-day zero-ref cache cleanup; the periodic artifact "
        "sweep found is multipart-session expiry ONLY (multipart-service.ts:864-900; server.ts:577-581,890-903). "
        "NO READY-artifact retention sweep (no DELETE FROM artifacts or artifact-byte TTL). expires_at nullable "
        "but upload INSERT does not populate it; grant expiry lives in token_expires_at separately (0001:138-142; "
        "artifacts.ts:140-146). (8) MUST-NOT-REPLICATE #2 VERIFIED BY ME - conditional raw-read bypass: both the "
        "runtime blob GET and the public download handler call decryptStoredArtifact ONLY when "
        "ctx.artifactDecryptDeps is non-null, then fall through to ctx.artifacts.getBlob(...) when it is null "
        "(server.ts:1548-1562 and 2048-2053 - I read both live). The helper itself WOULD refuse a sealed object "
        "without a facade (fail 503, artifact-read-decrypt.ts:175-186 - I read this) but it is never reached on "
        "the null-deps path, so a sealed artifact is served raw. All claims file:line. Feeds COMP-00 decision #4 "
        "(lifecycle+retention) + COMP-05. No fixes proposed, no gates ticked."
    )
    e["lastObservedAt"] = NOW
    e["consecutiveUnfinishedChecks"] = 0
    e["blocker"] = None
    print("SETTLED", key)

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(x["status"] for x in disp.values())
print("watch-state total", len(disp), dict(c))
