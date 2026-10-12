# VFY-ORV15-HA independent unit verification

Status: **unit/package scope verified for the frozen source snapshot**. This is
not live HA acceptance, runtime identity proof, or a blue/green cutover result.
The verifier changed only the independent test and its report/raw artifacts.

On 2026-10-12, I ran the independent suite from
`/workspace/dugate/du-rework/orchestrator/services/orchestrator` with Node
24.21.0:

```sh
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node ./node_modules/jest/bin/jest.js \
  --config jest.unit.config.cjs --runInBand tests/orv15-vfy-ha-package.test.ts
```

The run started at `2026-10-12T05:57:37Z` and finished exit 0: **1 suite, 5
tests passed, 0 failed, 0 skipped**. It exercises the actual selector renderer
for all four Orchestrator/Connector slot combinations, exact stdout and
unchanged selector/include files; rejects invalid values, multiple lines, and
symlink selectors without writes; and confirms a real non-root process is
denied by the production selector even with `DU_AVAILABILITY_TEST_MODE=true`.
It executes the actual Compose bootstrap script with both an incorrect config
hash and a correctly hashed forbidden runtime-identity override, checking the
generic failure and absence of the sentinel value.

The suite invokes the actual Orchestrator `handleRuntimeRoutes` upload-grant
handler with a synthetic artifact port and confirms it builds the URL from the
configured `http://du-availability-ingress:8080` origin. The Nginx contract
asserts that private listener 8080 accepts only the documented Worker subnet
`172.31.0.0/24`, preserves the runtime API path to the selected Orchestrator
API upstream, and that 8081 has the documented local/control subnet ACL and
forwards authenticated Orchestrator and Connector identity probes to their
real route prefixes. Public Admin BFF forwarding preserves Authorization and
uses its distinct upstream; public internal paths are denied and the public
Connector prefix is rewritten before proxying.

During source review, the package still pointed that runtime grant origin at
`127.0.0.1:3002`, which would direct a Worker fetch back to the Worker process.
I reported the mismatch to the coordinator and Host owner; the owner changed
the packaged origin to the private ingress route before the frozen run. The
source freeze and final independent handler assertion both use the corrected
value. Connector artifact bytes are supplied inline in invocation input, so
the Connector subnet was not added to the Worker-only 8080 allowlist.

The same suite parses a synthetic six-slot manifest through the production
`TrustedRolloutManifestSchema`, checks each slot's image and compose-file SHA
shape, and rejects a worker probe and malformed file digest. It confirms the
example Worker has no published ports and the fixed ingress bind-mounts only
the read-only ingress directory and TLS directory. These schema pins are
synthetic inputs; the supplied overlay examples intentionally remain invalid
templates, so this does not verify root-owned rendered release files.

After the unit suite passed, the allowed read-only Compose syntax check ran at
`2026-10-12T05:58:01Z`, exit 0, using an explicit empty env file and a unique
temporary project directory:

```sh
/usr/local/bin/docker compose \
  --project-directory /workspace/scratch/orv15-vfy-ha-compose-20261012-a \
  --env-file /workspace/scratch/orv15-vfy-ha-compose-20261012-a/empty.env \
  -f /workspace/dugate/du-rework/compose/availability.yml config --quiet
```

The empty env file and unique directory were removed after the command. No
image build/pull, container or network creation, service start, HTTP, DB,
Redis, S3, Vault, provider, namespace, or Nginx command was run. A separate
read-only `docker compose version` metadata query was also used during initial
tool inspection and returned Compose v2.40.3; it had no resource effects.

The test initially had a verifier-only block-selection error: its route helper
matched `/connector/internal/` before the public `/connector/` block. That
attempt is preserved in `coordination/reports/raw/orv15-vfy-ha/independent-unit-attempt-01-harness-red.txt`;
the helper was narrowed and the final suite passed. A subsequent test-output
capture also used the wrong relative directory; the suite passed, the capture
error is preserved in `coordination/reports/raw/orv15-vfy-ha/unit-capture-path-error.txt`,
and a correctly captured run passed in
`coordination/reports/raw/orv15-vfy-ha/independent-unit-attempt-02.txt`. Final raw output is
`coordination/reports/raw/orv15-vfy-ha/independent-unit-final.txt`; Compose output is
`coordination/reports/raw/orv15-vfy-ha/compose-config-quiet.txt`.

The original independent run used the earlier package freeze. The final bounded
R1/R2 rerun below supersedes the affected Nginx and selector hashes and records
the exact pre/post source snapshot used for the owner and independent suites.

| File | SHA-256 |
| --- | --- |
| `compose/availability.yml` | `97dcdd057026770c1ef7265b2268578f52e0e53c8bb0fde887e6cfa37c7b3014` |
| `compose/availability-slot.env.example` | `a83dbabec7d36a5f94d896cf321e33f50cacc9e9e9e1d88c45c747b9ecccd0f3` |
| `compose/availability/slot-release.example.yml` | `c355ab33b080ed5d0d3c449109ac9941a8c2731c668218c1d22b61901a9fc2e2` |
| `compose/ingress/nginx.conf` | `ce4b77352943f4b12bc64c7f7b9b81c74437eef056b4969b7884534b32f0ed99` |
| `compose/ingress/reload-selector` | `68502564455cde35c2098fbd500c869a6d54a7829a2664b2de17d47da2f684eb` |
| `compose/ingress/selected-upstream.conf` | `594e03f515cf0324893eca68c8f06e145f9b79dcf492cb4b089edd8a015225a3` |
| `docs/55-compose-two-slot-deployment.md` | `15a2cd98c7490a03e4644f14cb89b833ae9681beccfcd078de0f0d189e38fb84` |
| Owner suite, not included in my independent count: `orchestrator/services/orchestrator/tests/orv15-ha-compose-package.test.ts` | `8aeafb98ec1be572f57320d38502685440e82a99bb341ea8cb09641e8b7f703c` |
| Independent suite: `orchestrator/services/orchestrator/tests/orv15-vfy-ha-package.test.ts` | `e0e3be5791d370f544daec66a3fc54e9f5d11fa607424ebb8bda414c5d1c7ab2` |

The Host owner reported a separate 7/7 owner run on the prior snapshot; it is
superseded by the final combined run below and is not added to the independent
count. Static unit checks confirm the configured loopback
`127.0.0.1:18081` publication and the Nginx allowlist, but cannot prove which
source address Docker host-port DNAT presents to Nginx. That native visibility
check remains open. No live serving replica, actual identity response, image,
drain, rollback, or cutover was exercised.

## Final R1/R2 unit rerun

At `2026-10-12T06:11:50Z`, I ran the frozen Host owner suite together with the
independent suite once, from
`/workspace/dugate/du-rework/orchestrator/services/orchestrator`, using Node
24.21.0:

```sh
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node ./node_modules/jest/bin/jest.js \
  --config jest.unit.config.cjs --runInBand \
  tests/orv15-ha-compose-package.test.ts tests/orv15-vfy-ha-package.test.ts
```

Result: **2 suites passed, 18 tests passed, 0 failed, 0 skipped**. The owner
suite contributed 13 tests; the independent suite contributed 5. These counts
remain separate: only the 5-test suite is independent verification. Raw output
is in `coordination/reports/raw/orv15-vfy-ha/r1-r2-final-jest.txt`.

The owner test's two-process selector harness copies the actual
`reload-selector` helper to a unique temporary directory and substitutes only
its fixed availability-root and Docker executable paths. Its `id`, Docker,
`mkdir`, and `rmdir` commands are temporary stubs/wrappers; lock barriers are
bounded and use real temporary-directory operations. It does not run Docker,
change the helper's locking algorithm, or prove native permissions. In this
scoped harness, the final cases verify that the shared lock is held before both
selector reads, concurrent slot updates preserve both selections, and HUP,
INT, or TERM exits without continuing to a reload and releases the lock once.
The package suite also checks the explicit 64m Nginx body limit. These results
resolve those source-review findings at unit scope only.

The R1/R2 pre-run and post-run manifests are
`coordination/reports/raw/orv15-vfy-ha/r1-r2-source-pre.txt` and
`coordination/reports/raw/orv15-vfy-ha/r1-r2-source-post.txt`. Their sampled
hashes match for every listed input. In particular, the tested Nginx hash is
`ce4b77352943f4b12bc64c7f7b9b81c74437eef056b4969b7884534b32f0ed99` and the
tested selector hash is
`68502564455cde35c2098fbd500c869a6d54a7829a2664b2de17d47da2f684eb`.
Compose YAML did not change in R1/R2, so the earlier read-only `docker compose
config --quiet` result remains the applicable syntax check; no image or
container operation was performed.

The host-published loopback `127.0.0.1:18081` source-address visibility after
Docker DNAT remains unverified. The unit suites do not establish native
ingress reachability, live runtime identity, health, drain, rollback, or
blue/green cutover behavior.
