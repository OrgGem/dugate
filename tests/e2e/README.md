# Profile, queue, worker and connector E2E

Run `npm run test:e2e:connector` after starting the app, worker, PostgreSQL,
Redis and `mock-service`. The test process needs `DATABASE_URL` and `REDIS_URL`
for the same database and Redis instance used by the app and worker. Start the
worker with `ALLOWED_PRIVATE_HOSTS=localhost` for a local mock service, or
`ALLOWED_PRIVATE_HOSTS=mock-service` in Docker. The mock service uses
`MOCK_API_KEY=DUMMY_SECRET_KEY` by default.

The test creates a unique API key/profile, connector, six profile endpoint
registrations and one workflow schema. It sends multipart requests to all six
document APIs and to `/api/v1/docs/workflows/schema`, then checks the database,
BullMQ job completion, mock HTTP calls, response content and token usage. It
deletes its own database rows and mock call history afterward.

Environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:2023/api/v1` | App URL visible to the test process |
| `E2E_MOCK_WORKER_URL` | `http://localhost:3099` | Mock URL visible to the worker |
| `E2E_MOCK_CONTROL_URL` | `http://localhost:3099` | Mock URL visible to the test process |
| `E2E_MOCK_API_KEY` | `DUMMY_SECRET_KEY` | Mock authentication key |

The connector implementation sends multipart form data. The mock therefore
accepts multipart requests and returns an OpenAI chat completion response,
including `choices[0].message.content` and `usage`.
