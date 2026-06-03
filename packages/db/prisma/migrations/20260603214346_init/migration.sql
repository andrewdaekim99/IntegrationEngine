-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'SUCCEEDED', 'DEDUPED', 'RETRYING', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "SyncRunOutcome" AS ENUM ('PENDING', 'SUCCEEDED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE', 'DEDUPED');

-- CreateTable
CREATE TABLE "IngestedEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" "EventStatus" NOT NULL DEFAULT 'RECEIVED',

    CONSTRAINT "IngestedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcome" "SyncRunOutcome" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetterItem" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "lastError" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DeadLetterItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MappingConfig" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "destinationSystem" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fields" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MappingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IngestedEvent_status_idx" ON "IngestedEvent"("status");

-- CreateIndex
CREATE INDEX "IngestedEvent_source_externalId_idx" ON "IngestedEvent"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "IngestedEvent_source_externalId_topic_key" ON "IngestedEvent"("source", "externalId", "topic");

-- CreateIndex
CREATE INDEX "SyncRun_eventId_idx" ON "SyncRun"("eventId");

-- CreateIndex
CREATE INDEX "SyncRun_outcome_idx" ON "SyncRun"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetterItem_eventId_key" ON "DeadLetterItem"("eventId");

-- CreateIndex
CREATE INDEX "DeadLetterItem_resolvedAt_idx" ON "DeadLetterItem"("resolvedAt");

-- CreateIndex
CREATE INDEX "MappingConfig_sourceSystem_destinationSystem_isActive_idx" ON "MappingConfig"("sourceSystem", "destinationSystem", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MappingConfig_sourceSystem_destinationSystem_version_key" ON "MappingConfig"("sourceSystem", "destinationSystem", "version");

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "IngestedEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadLetterItem" ADD CONSTRAINT "DeadLetterItem_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "IngestedEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
