-- CreateTable
CREATE TABLE "EndpointConnectionConfig" (
    "id" TEXT NOT NULL,
    "endpointSlug" TEXT NOT NULL,
    "connections" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EndpointConnectionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EndpointConnectionConfig_endpointSlug_key" ON "EndpointConnectionConfig"("endpointSlug");

-- CreateIndex
CREATE INDEX "EndpointConnectionConfig_endpointSlug_idx" ON "EndpointConnectionConfig"("endpointSlug");
