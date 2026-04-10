-- AlterTable: Add stepId column to ExternalApiOverride
ALTER TABLE "ExternalApiOverride" ADD COLUMN "stepId" TEXT NOT NULL DEFAULT '_default';

-- Drop old unique index
DROP INDEX IF EXISTS "ExternalApiOverride_connectionId_apiKeyId_endpointSlug_key";

-- Create new unique constraint including stepId
ALTER TABLE "ExternalApiOverride" ADD CONSTRAINT "ExternalApiOverride_connectionId_apiKeyId_endpointSlug_stepId_key" UNIQUE ("connectionId", "apiKeyId", "endpointSlug", "stepId");
