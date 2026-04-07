/*
  Warnings:

  - You are about to drop the column `defaultParams` on the `ProfileEndpoint` table. All the data in the column will be lost.
  - You are about to drop the column `profileParams` on the `ProfileEndpoint` table. All the data in the column will be lost.
  - You are about to drop the `EndpointConnectionConfig` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Operation" ADD COLUMN     "createdByUserId" TEXT;

-- AlterTable
ALTER TABLE "ProfileEndpoint" DROP COLUMN "defaultParams",
DROP COLUMN "profileParams",
ADD COLUMN     "connectionsOverride" TEXT,
ADD COLUMN     "parameters" TEXT;

-- DropTable
DROP TABLE "EndpointConnectionConfig";

-- CreateIndex
CREATE INDEX "Operation_createdByUserId_createdAt_idx" ON "Operation"("createdByUserId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
