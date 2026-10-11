# example-review local worker

`example-review` is a queue worker with no public HTTP listener. Its application config requires Orchestrator's Runtime URL/token and Redis; it does not declare a Connector URL requirement.

## Start

From this directory:

```powershell
./start-local.ps1
```

```bash
bash ./start-local.sh
```

Use `-EnvFile D:\path\to\profile.env` in PowerShell or pass the env-file path as the first Bash argument. The common runner currently waits for both Orchestrator and Connector health before starting any worker, so start Connector as well even though this business config does not consume it directly.

## Required configuration and dependencies

Start PostgreSQL, Redis, Orchestrator, and Connector before this launcher. Configure `DATABASE_URL`, `REDIS_URL`, `SERVICE_IDENTITY_SECRET`, `INVOCATION_GRANT_SECRET`, `CONNECTOR_ENCRYPTION_KEY`, `CONNECTOR_INVOCATION_ENCRYPTION_KEYS`, and `EXAMPLE_REVIEW_RUNTIME_TOKEN` (or that business's entry in `WORKER_IDENTITY_TOKENS_BY_BUSINESS`). The runner maps the selected runtime token and defaults `RUNTIME_URL` to `http://127.0.0.1:3002/api/runtime/v1`. It mints a short-lived Connector identity for this local worker session because that is required by the shared runner's worker startup contract.

The launcher skips builds and Orchestrator migrations and expects workspace build artifacts to exist. It does not register the manifest. See [`coordination/reports/local-dev-services-guide.md`](../../coordination/reports/local-dev-services-guide.md) for manifest provisioning and the startup order. Press Ctrl+C to stop this worker session.
