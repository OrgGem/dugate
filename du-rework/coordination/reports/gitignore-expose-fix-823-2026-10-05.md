# GITIGNORE-EXPOSE-FIX-823

Date: 2026-10-05 (Asia/Bangkok)  
Task: `task_417deba01d7c` / dispatch `ctx_1cadc84d5df4`  
Scope: narrow change to `du-rework/.gitignore`; no stage, commit, deletion, or task-plan tick.

## Change made

Inserted these three rules immediately before the existing `!.env.docker.example` exception in `du-rework/.gitignore`:

```gitignore
.env.live
.env.*.live
.env.*.local
```

The edit used a byte insertion; it did not decode/re-encode or normalize the file. The original file contained mixed CRLF/LF endings; all 134 original bytes were verified byte-for-byte unchanged and the 35 ASCII rule bytes were inserted using the exception line's LF convention. The file is confirmed changed on disk: mtime moved from `2026-10-05T13:05:34.6676283+07:00` to `2026-10-05T16:38:36.8738569+07:00`; SHA-256 changed from `1DAAF4E3468120C1205FE66BD4C9D7B24CCF03477A76D8FDC62FE31A0D401E30` to `CDA605F80234015AADE49C814BBA1CEEF30A386BD61C9EC96277E41A6AE88B6E`.

## Tracking and ignore verification

`git ls-files` before and after returned 2,573 paths with the same path-manifest SHA-256: `CB2A22A9B46BCF144273157C950E76647DF087A4560E1A8169083F7C23B60511`. The four tracked environment-template paths are unchanged and remain tracked:

- `.env.example`
- `du-rework/.env.example`
- `du-rework/.env.local.sample`
- `mock-service/.env.example`

No tracked file lost tracking. The new rules apply to the untracked local variants only.

Literal `git check-ignore -v --no-index` results after the edit:

```text
du-rework/.gitignore:8:.env.live       du-rework/.env.live
  verbose exit 0; `git check-ignore -q --no-index` exit 0 (ignored)

du-rework/.gitignore:11:!.env.docker.example       du-rework/.env.docker.example
  verbose exit 0; `git check-ignore -q --no-index` exit 1 (not ignored; exception works)

du-rework/.env.example
  no verbose match; verbose exit 1; `git check-ignore -q --no-index` exit 1 (not ignored)
```

Literal scoped status after the edit:

```text
git status --short -- du-rework/.gitignore du-rework/.env.live du-rework/.env.docker.example du-rework/.env.example
 M du-rework/.env.example
 M du-rework/.gitignore
?? du-rework/.env.docker.example

git status --short --ignored -- du-rework/.env.live du-rework/.env.docker.example du-rework/.env.example
 M du-rework/.env.example
?? du-rework/.env.docker.example
!! du-rework/.env.live
```

`du-rework/.env.example` was already modified before this task and remains tracked. `du-rework/.env.docker.example` stays visible as untracked. `.env.live` is now explicitly ignored, which is expected; ordinary `git status` no longer lists it, while `--ignored` confirms it is present and ignored.

## Safe tracked-secret audit

No secret values were emitted in command output or this receipt. A path-only credential-pattern scan and in-memory equality comparison against local env files found a **confirmed tracked credential exposure**: `du-rework/.env.local.sample` is present in `HEAD`, and multiple sensitive values in it exactly match values in the untracked local files `du-rework/.env.local` and `du-rework/.env.live`. This is a tracked-file issue; adding ignore rules does not remove that file from Git. It was left unchanged because the requested lease/scope allows edits only to `du-rework/.gitignore`.

The tracked root `.env.example` also contains a populated, random-looking sensitive field that did not exactly match either local env file; it remains an unconfirmed candidate, not a verified active credential. Token-shaped matches in `docker-compose.yml`, `du-rework/coordination/reports/qwen-cost.md`, and `lib/pipelines/workflows/README.md` did not match values in the local env files and were not confirmed as active secrets. Test-path matches were treated as fixture candidates. These scans cannot establish whether an unmatched value is valid with an external provider; the paths above are the only secret-related findings disclosed here, and no values are included.

## Scope and validation

Only pre-existing file edited for the fix: `du-rework/.gitignore`; this receipt is newly created as the requested audit artifact. No other file was modified, staged, or deleted; no commit or task-plan tick occurred. No test/build run was needed for this ignore-only change; actual matching, exceptions, tracked paths, and Git status were verified directly.
