# Orchestrator Portal / Swagger candidate packaging — 2026-10-06

## Result

**Clean local image candidate build: PASS (5/5 images).** The Portal branding and API Reference source were present in the working tree, and the Portal typecheck/Vite build passed. A separate `oc_1` completion receipt was not present in `coordination/reports` at verification time, so this receipt pins the source snapshot that was actually built and does not claim UI acceptance.

No business logic, Compose service topology, or runtime route code was changed. No container was started, no database was touched, no deployment was performed, and no existing `:local` tag was replaced.

## Packaging changes

- `.dockerignore` now re-includes only `docs/21-openapi.json` from the otherwise excluded `docs/` tree (lines 11–13). The Portal viewer imports that generated artifact as raw text at `apps/admin-web/src/features/api-docs/api-docs-screen.tsx:2`.
- `Dockerfile:18` copies that one generated artifact into the build workspace. The Vite build embeds it in the Portal JS bundle; the runtime image receives the normal `/deploy/orchestrator/admin-web` output through `scripts/docker/build-runtime.cjs:90–94`. Other docs remain excluded, and `**/dist` remains excluded from the Docker context, so the candidate rebuilds from source rather than a stale host bundle.
- Added `scripts/docker/candidate-build.hcl`, a five-target Buildx Bake group. It sets `pull = true` and `no-cache = true`, and tags every target with the same caller-supplied `DU_IMAGE_TAG`.
- The package/folder identity remains `@du/admin-web` / `apps/admin-web`, as the Portal README says this mapping is frozen until MIG-08C. This build does not claim the folder rename.

SHA-256:

| File | SHA-256 |
|---|---|
| `.dockerignore` | `4D3C20116ADCE98E288E787C494EE5EBBD72911558823D4C54678E899A9E1200` |
| `Dockerfile` | `62DDB7E498892C74DD80DA4335B2A0D1A85E5586F7CA09B05526301E66BB5C84` |
| `scripts/docker/candidate-build.hcl` | `EF87F23219D340C1504CB5067431F29E1789AB589B5C69B0253C00A4BE892E65` |
| `docs/21-openapi.json` | `BB6875EC39013DC4D99D6078734FD212DE6A9267366184F12F9287392630CA8D` |
| `apps/admin-web/src/features/api-docs/api-docs-screen.tsx` | `4AC05F07EA8C058C317BF001D965CD7383CE5BB73B9DC9CC38D668B26DD0C6FD` |
| `apps/admin-web/src/features/api-docs/openapi-types.ts` | `F2A8083FB3ECCA558224878B26A6797831C79EB5100A5E237F497E4A1C9A41E7` |
| `apps/admin-web/src/app-shell/app-shell.tsx` | `6D948A5130F71AB3BA65F9BB3C0FB47C7120F3EE2956B20E4AEB64630760BCC7` |
| `apps/admin-web/src/router.tsx` | `35185B7736A50C17F23E4E543BB5E95FE6FD8168310C49EF8F032C4B5EF35464` |

## Verification

| Command / check | Result |
|---|---|
| `pnpm --filter @du/admin-web run build` | **Exit 0**; TypeScript and Vite passed. Host Node was 22.16.0 and emitted the workspace's Node `>=24.21.0 <25` engine warning; the Docker candidate compiled under the pinned Node 24.21 image. Vite retained its existing >500 kB chunk warning. |
| `docker buildx bake --print --file scripts/docker/candidate-build.hcl candidate` with `DU_IMAGE_TAG=candidate-portal-swagger-20261006-r2` | **Exit 0**; prints exactly five targets and unique candidate tags. |
| `docker buildx bake --load --progress=plain --file scripts/docker/candidate-build.hcl candidate` with the same tag | **Exit 0**; `pull` + `no-cache`, pinned `node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`. BuildKit fetched 654 locked packages, then ran the service builds with network disabled. Raw output: `coordination/reports/raw/portal-swagger-candidate-build-2026-10-06/candidate-bake.log`; exit file records `0`. |
| One-shot `docker run --rm --entrypoint node` check against Orchestrator r2 | **Exit 0**; `/app/admin-web/index.html` and JS/CSS assets exist; bundle contains Orchestrator Portal title, `/api-docs`, API Reference, `/api/v1/admin/actions`, API-family filter and disabled Try-it-out text; no `cdn.jsdelivr.net` or `unpkg.com` reference. No service or port was started. |
| `node scripts/docker/verify-pm-m02-merge.cjs --project-name pm-m02-verify-portal-candidate-20261006 --env-file .env.docker --config-only` | **Exit 0**; default Compose keeps 3002/8080 unpublished and workers target Runtime on `http://orchestrator:3002/api/runtime/v1`. Config-only mode inspected or started no containers. |

Final candidate image IDs (runtime user `node`):

| Image | Image ID | Exposed ports |
|---|---|---|
| `du-orchestrator:candidate-portal-swagger-20261006-r2` | `sha256:08250516cfdfb860c47b70d36b396919a12bdc5252154f25706ea307880b7e4e` | `3000/tcp, 3001/tcp` |
| `du-connector:candidate-portal-swagger-20261006-r2` | `sha256:4f48f7b8a30d9f8b31094d2539d3b767d593f2672464d2159c388f4c768166b4` | `8080/tcp` |
| `du-document-core:candidate-portal-swagger-20261006-r2` | `sha256:e29997b5e8048b74dc3646003ecd90348834370988aa64bea6a7bdd03027dd85` | none |
| `du-lc-checker:candidate-portal-swagger-20261006-r2` | `sha256:4195801832445fc19f6f05bf5e50583dbc48e0d83ec93457d61f89f0265bea24` | none |
| `du-example-review:candidate-portal-swagger-20261006-r2` | `sha256:d964b9a8d9c4dc637f1b83ecf7932db8248368f7764d9984ed8c9093dabd0002` | none |

The Connector has an image-level `EXPOSE 8080` metadata declaration; the verified default Compose config does not publish it to the host. Orchestrator image metadata exposes only 3000/3001; default Compose does not publish 3002.

## Integration hold and scope limits

- The packaged page is a first-party React **Swagger-style OpenAPI viewer**, not the upstream `swagger-ui` / `swagger-ui-dist` asset. It renders operations and schemas from the generated spec without a CDN or runtime fetch. If the acceptance item requires the upstream Swagger UI asset specifically, UI review must resolve that wording; this build does not claim it.
- `apps/admin-web/README.md:93–100` states that backend `ADMIN_WEB_ROUTE_NAMES` in `services/orchestrator/src/app/admin/shell-server.ts:335` does not yet contain `api-docs`. With `DU_ADMIN_WEB_ROUTES` set to a non-empty allow-list, `/admin/web/api-docs` is therefore gated by the server's 404 policy. Compose defaults this variable to empty, so the SPA route is not narrowed by that optional flag. Backend allow-list code is outside this deployment lease and was not changed.
- The image build is not a browser/session acceptance run. It does not verify authenticated navigation, browser behavior, route enablement, API contract parity, or the Ingest/Extract flow on these new r2 digests. The coordinator's prior Docker Ingest/Extract PASS remains separate evidence and was not repeated against r2 here.
- No security scan/SBOM or acceptance tick was performed. The Master Plan's existing security/review gates remain in force.

## Cache diagnostic

A normal cached Connector build initially failed in `pnpm deploy --offline` with `ERR_PNPM_NO_OFFLINE_TARBALL` for `@ioredis/commands`. The clean no-cache Connector build then fetched the full lock and passed, and the final five-image no-cache Bake also passed. The HCL candidate group deliberately disables layer cache so a partial old pnpm store cannot masquerade as a clean image build.
