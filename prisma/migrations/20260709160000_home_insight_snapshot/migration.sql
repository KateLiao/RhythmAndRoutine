-- CreateTable
CREATE TABLE "HomeInsightSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "factsHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "proposedChange" JSONB,
    "alternateCandidates" JSONB,
    "alternateIndex" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "modelId" TEXT,
    "userResponse" TEXT,
    "appliedAt" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HomeInsightSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HomeInsightSnapshot_userId_kind_generatedAt_idx" ON "HomeInsightSnapshot"("userId", "kind", "generatedAt");

-- AddForeignKey
ALTER TABLE "HomeInsightSnapshot" ADD CONSTRAINT "HomeInsightSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
