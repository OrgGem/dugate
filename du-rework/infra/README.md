# Infrastructure

`docker-compose.yml` provides the isolated `du-rework-test` PostgreSQL 16 and
Redis 7 dependencies on loopback ports 5433 and 6380. The default Compose
project remains dependency-only. Its opt-in `connector` profile builds the
Connector image, waits for both dependencies to become healthy, and probes
`GET /health/ready` on the local-only port 8081. The profile is a single
replica integration fixture, not a production deployment topology.

Run from the `du-rework/` directory:

```sh
docker compose -f infra/docker-compose.yml config --quiet
docker compose -f infra/docker-compose.yml up -d postgres redis
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml --profile connector up -d --build connector
```

The final command is optional and starts Connector against the isolated test
database. `docker compose -f infra/docker-compose.yml down` removes these
containers. PostgreSQL has no persistent volume in this fixture, so `down`
also removes its test data; do not run it while another test owns the DB window.

The Connector image uses the Node 20 Alpine base and its exec-form shell
entrypoint leaves Node as the signal receiver. The Compose stop grace is 40
seconds for the Connector's default 30-second HTTP and usage-outbox drain.
Connector startup applies pending SQL migrations before opening the listener;
do not enable the profile against a shared or production database without the
approved migration run request and recovery point.

See [operational runbooks](../docs/17-operational-runbooks.md#connector-compose-health-and-shutdown-contract),
[operations](../docs/12-operations.md), [P1 foundation](../tasks/P1-foundation-contracts.md),
and [P8 readiness](../tasks/P8-release-readiness.md). Production deployment,
backup/restore rehearsal, and multi-replica Compose topology remain separate
readiness work. For build, test, and Public API usage, see the [root README](../README.md).

