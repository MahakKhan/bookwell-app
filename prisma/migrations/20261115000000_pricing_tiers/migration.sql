-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "planStartedAt" TIMESTAMP(3),
ADD COLUMN     "trialUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "usageAlertCycle" TEXT;

