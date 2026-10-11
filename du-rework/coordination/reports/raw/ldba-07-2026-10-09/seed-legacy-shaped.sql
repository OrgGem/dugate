-- synthetic legacy-shaped source tables (PascalCase + camelCase columns), explicit UTC
CREATE TABLE IF NOT EXISTS "AppSetting" (
  id text PRIMARY KEY,
  key text NOT NULL,
  value text,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL
);
CREATE TABLE IF NOT EXISTS "ExternalApiConnection" (
  id text PRIMARY KEY,
  name text,
  url text,
  "authType" text,
  "authSecret" text,
  "staticFormFields" text,
  "extraHeaders" text,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL
);
CREATE TABLE IF NOT EXISTS "User" (
  id text PRIMARY KEY,
  username text,
  password text,
  role text,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL
);
CREATE TABLE IF NOT EXISTS "ApiKey" (
  id text PRIMARY KEY,
  name text,
  "keyHash" text,
  role text,
  "spendingLimit" double precision,
  "totalUsed" double precision,
  status text,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL
);
CREATE TABLE IF NOT EXISTS "Operation" (
  id text PRIMARY KEY,
  "apiKeyId" text,
  "createdByUserId" text,
  "idempotencyKey" text,
  done boolean,
  state text,
  "progressPercent" integer,
  "progressMessage" text,
  "endpointSlug" text,
  "pipelineJson" text,
  "totalCostUsd" double precision,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL
);
CREATE TABLE IF NOT EXISTS "UserProfileAssignment" (
  id text PRIMARY KEY,
  "userId" text NOT NULL,
  "apiKeyId" text NOT NULL,
  "createdAt" timestamp NOT NULL
);
INSERT INTO "AppSetting" (id, key, value, "createdAt", "updatedAt") VALUES
 ('as-1','wb_schema:disbursement','{"version":1,"steps":[]}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
 ('as-2','wb_schema:lc-checker','{"version":1,"steps":[]}','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z'),
 ('as-3','wb_schema:lc-checker','{"version":2,"steps":[]}','2026-01-01T00:00:00Z','2026-03-01T00:00:00Z'),
 ('as-4','ai_provider','openai','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO "ExternalApiConnection" (id, name, url, "authType", "authSecret", "staticFormFields", "extraHeaders", "createdAt", "updatedAt") VALUES
 ('eac-1','legacy-conn-a','https://vendor-a.example.test/invoke','bearer','synthetic-secret-a','{}','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
 ('eac-2','legacy-conn-b','http://vendor-b.example.test/invoke','apiKey','synthetic-secret-b',NULL,NULL,'2026-01-01T00:00:00Z','2026-01-05T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO "User" (id, username, password, role, "createdAt", "updatedAt") VALUES
 ('u-1','legacy-admin','$2b$10$syntheticbcrypthashvaluexxxxxxxxxxxxxxxxxxxxxxxxxxxxx','ADMIN','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
 ('u-2','legacy-user','$2b$10$syntheticbcrypthashvalueyyyyyyyyyyyyyyyyyyyyyyyyyyyyy','USER','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z'),
 ('u-3','legacy-viewer','','VIEWER','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO "ApiKey" (id, name, "keyHash", role, "spendingLimit", "totalUsed", status, "createdAt", "updatedAt") VALUES
 ('k-1','legacy-key-1','synthetic-hash-1','STANDARD',100.5,10.25,'ACTIVE','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
 ('k-2','legacy-key-2','synthetic-hash-2','ADMIN',0,42.75,'ACTIVE','2026-01-01T00:00:00Z','2026-01-03T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO "Operation" (id, "apiKeyId", "createdByUserId", "idempotencyKey", done, state, "progressPercent", "progressMessage", "endpointSlug", "pipelineJson", "totalCostUsd", "createdAt", "updatedAt") VALUES
 ('op-1','k-1','u-1','idem-1',true,'SUCCEEDED',100,'done','extract:invoice','{"steps":[]}',1.25,'2026-01-01T00:00:00Z','2026-01-01T01:00:00Z'),
 ('op-2','k-1',NULL,'idem-2',false,'RUNNING',50,'working','analyze:summary','{"steps":[]}',0,'2026-01-02T00:00:00Z','2026-01-02T00:30:00Z'),
 ('op-3','k-2','u-2',NULL,false,'FAILED',10,'boom','transform:convert','{"steps":[]}',2.5,'2026-01-03T00:00:00Z','2026-01-03T00:05:00Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO "UserProfileAssignment" (id, "userId", "apiKeyId", "createdAt") VALUES
 ('upa-1','u-1','k-1','2026-01-01T00:00:00Z'),
 ('upa-2','u-2','k-2','2026-01-02T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
