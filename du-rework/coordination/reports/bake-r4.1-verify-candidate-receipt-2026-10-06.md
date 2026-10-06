# D-BAKE-r4.1 verify candidate receipt

- Date: 2026-10-06T13:28:58.094868+00:00
- Scope: Claude Reviewer Section 11.1, local VERIFY candidate only. No release, production promotion, registry push, Git commit, DB migration or live test.
- Status: BAKE PASS (5/5); packaged-artifact checks PASS. Independent feature acceptance and live release gates remain OPEN.
- Base commit: `4308cc54eda32cfcca54e0c55554fc85d720a43b`. Frozen context: `C:\Users\Gem\AppData\Local\Temp\du-bake-r41-aorfjbcv\du-rework`.
- Tag: `candidate-portal-swagger-20261006-r4.1`. Label: `du.candidate=verify-only`.

## Freeze and accepted overlays

Built from git archive of the base commit plus exactly 17 SHA-checked overlay files. Existing baseline functionality is retained; unapproved working-tree deltas are excluded. Full working-tree diff names/status and patch were captured before bake. Per-file overlay hashes pin the accepted hunks; working-tree.diff preserves their patch context. Browser-test and generator/validator deltas are excluded from image build. The current validator is copied into the provenance bundle as verification tooling only.

| Overlay path | SHA-256 |
|---|---|
| `packages/contracts/src/profile-policy.ts` | `145425a60d8982980c3985c8cd47d5df36b4d0edcde002c1dc14361b90a19cad` |
| `services/orchestrator/src/modules/operations/submission.ts` | `04ec1433310b7027ca0226d16c17fe33151d97187bacab675764a7e5f75b29ea` |
| `services/orchestrator/src/modules/operations/retry.ts` | `a0e63828b2049251432aca741815e2e80c7a59b5d4b4292a7891d514b574f94b` |
| `services/orchestrator/src/modules/profiles/profiles.ts` | `376d0c7aa38676c19dad2fbd698e5dea2e2d7ba09a929f9f12ded33f9005cc82` |
| `services/orchestrator/src/modules/admin-read/profile-detail.ts` | `3a78270cbd850f50361f724b451a8d1f83d72fdf8959c1b4162f5aee61f642da` |
| `services/orchestrator/src/server.ts` | `4fc40290bdfed910b1673e0c2069407bc6532597a9fa440d421a9948436b7a58` |
| `services/orchestrator/src/app/bootstrap/create-app.ts` | `aa04f12093abdd7e359d8e8b9551814961d409f8c63ba43e10560dc0f15767bc` |
| `services/orchestrator/migrations/0036_profile_callback_policy.sql` | `5ad75bff28014f70776233910d1e5c995f5ec04657557c5778f1f871840c8896` |
| `services/orchestrator/tests/cb02-admission-writer.test.ts` | `e34e1a2207c669cd65d837ce41103ed93f1b691f8951274a4484eb62bf4be8af` |
| `services/orchestrator/tests/vfy-cb01-dispatch-matrix.test.ts` | `2adf98929fe2f7e176de3fce1560d9c78cd2bac0f0235241df0abaf1d94ae011` |
| `services/orchestrator/src/app/admin/bff/secrets.ts` | `e843a77165f4725ef1a489320f95e996d4a6d86037cdec5d341b8ad30d42801d` |
| `services/orchestrator/src/modules/webhooks/webhooks.ts` | `19226078d1fe1bd4a9210ed1655f6415338cc6e5f236504fe57f2c0b573d361c` |
| `services/orchestrator/src/modules/webhooks/outbound-auth.ts` | `44435e1e89f5b685d84b7319bf1c66c36bff783df3e38ab2b53d718b3701397a` |
| `services/orchestrator/src/modules/webhooks/oauth2-client.ts` | `ebf7f1eb26f211565cfa1dc43ea2560fbcf82301b080f00aecf875cb5cc6bbd0` |
| `services/orchestrator/src/http/routes/public.ts` | `48c45d6f5dd610a7d7c494401f08ca29cfefcb28b8f5790fe9268e3f5ef212ec` |
| `services/orchestrator/tests/multipart-routes-offline.test.ts` | `fe7875318df888c9ace60c54fc3c0d077be38527556ee44f1f9a32cef77fbbdd` |
| `docs/21-openapi.json` | `1388add7b1a30b535228f9acc1e04e23123de1aaeda9e17cb9e3057339c5c89c` |

## Build and resulting images

CWD: frozen context above. Command:

```powershell
$env:DU_IMAGE_TAG="candidate-portal-swagger-20261006-r4.1"
docker buildx bake --load --progress=plain --file scripts/docker/candidate-build.hcl --metadata-file <raw>/build-metadata.json --set "*.labels.du.candidate=verify-only" --set "*.labels.org.opencontainers.image.revision=4308cc5" candidate
```

- Bake exit: **0**; HCL requests pull=true and no-cache=true. Docker Server 28.5.1 / buildx v0.29.1-desktop.1.
- Root multi-target Dockerfile and ancillary service Dockerfiles are captured. Node base is pinned to `node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`; base-image-inspect.json records local RepoDigest. Docker metadata captures BuildKit provenance and resulting manifests.

| Image | Local image ID | BuildKit manifest digest | Runtime Node |
|---|---|---|---|
| orchestrator | `sha256:ce35749edf35559095504f749ea9cfc63731e55e8c638a9e467c365a0a4f35c6` | `sha256:ce35749edf35559095504f749ea9cfc63731e55e8c638a9e467c365a0a4f35c6` | v24.21.0 |
| connector | `sha256:d54c29f54daac7e4bf20eaea8d2a688fb911cda745594a01b0531101d44cc71f` | `sha256:d54c29f54daac7e4bf20eaea8d2a688fb911cda745594a01b0531101d44cc71f` | v24.21.0 |
| document-core | `sha256:e1b7ce7e5ac8e9dda72d10660159bcc79642f92265203f9e1e0d47c1bbd9e408` | `sha256:e1b7ce7e5ac8e9dda72d10660159bcc79642f92265203f9e1e0d47c1bbd9e408` | v24.21.0 |
| lc-checker | `sha256:670560fc549f9ca10a9f0f04cdead93e48f232286e833fff100b4e3ba0daf60a` | `sha256:670560fc549f9ca10a9f0f04cdead93e48f232286e833fff100b4e3ba0daf60a` | v24.21.0 |
| example-review | `sha256:1545679e7574123403a606e5b62abc2d1da2b7f8f0a22aedbee32a1c967ec9fe` | `sha256:1545679e7574123403a606e5b62abc2d1da2b7f8f0a22aedbee32a1c967ec9fe` | v24.21.0 |

## Packaged artifact verification

- `verify-bundle.py` exit **0**. Each image has the candidate label and runs Node v24.21.0 (5/5 runtime probes, exit 0).
- OpenAPI extracted from the actual Portal JavaScript asset inside the newly built Orchestrator container: byte-identical to the frozen reconciled source, **234127 bytes**, SHA-256 `1388add7b1a30b535228f9acc1e04e23123de1aaeda9e17cb9e3057339c5c89c`. Version 1.4.0, 58 paths / 62 operations / 51 schemas.
- Validator executed against the extracted bundled artifact: `python du-rework/tools/openapi/validate_openapi.py --spec <raw>/bundled-openapi.json`, repository-root cwd, exit **0**; raw output in bundled-validator.log. No generator rerun or hand-edit of the approved artifact.
- Migration 0035 and 0036 are present in `/app/migrations`, and their bytes match frozen source (migration-files.json). **No applied-state claimed**: DB migration ledger must be checked separately on the r4.1 verification DB.
- Initial extractor attempt truncated stdout to 65536 bytes because of premature process.exit; extractor corrected to synchronous output, final byte comparison and validation passed. No image/product code change was required.

## Open gates and handoff

- Group A exact-path x3 rerun is an independent coordinator-owned parallel packet. Existing vfy-group-a-rerun-2026-10-06.md reports PARTIAL and count mismatch. This bake neither dispatches nor closes that packet; it remains a prerequisite for acceptance.
- Live PG/S3/Vault persistence, boot matrix, HTTPS IdP/receiver, migration applied-state and Portal roundtrip are NOT RUN by this build packet. Run only against the recorded r4.1 image digests after provenance review.
- Secrets backend remains degraded per reviewer Section 11.2; baking BFF dispatch does not implement the secret catalog persistence API. REVIEW-07 stays CHANGES_REQUIRED.
- No ACCEPTED or production-readiness claim.

## Provenance Bundle

[Raw bundle](raw/bake-r4.1-2026-10-06/) contains freeze-manifest.json (all source file hashes), git-diff-name-only.txt, git-status.txt, working-tree.diff, excluded-working-tree-files.txt, Dockerfiles, HCL, base-image-inspect.json, build.log/build.exit.txt, build-metadata.json, per-image inspections, images.json, extracted bundled-openapi.json, validator snapshot/output/exit, migration-files.json, extraction and verification scripts, and SHA256SUMS.txt. Frozen temporary context is retained for reproduction.
