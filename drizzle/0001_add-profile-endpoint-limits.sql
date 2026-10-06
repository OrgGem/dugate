ALTER TABLE "ProfileEndpoint" ADD COLUMN "rateLimitPerMin" integer;--> statement-breakpoint
ALTER TABLE "ProfileEndpoint" ADD COLUMN "maxConcurrent" integer;