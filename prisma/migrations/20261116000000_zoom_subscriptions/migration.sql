-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "zoomAccessToken" TEXT,
ADD COLUMN     "zoomRefreshToken" TEXT,
ADD COLUMN     "zoomTokenExpiry" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "autoZoom" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "zoomMeetingId" TEXT;

-- AlterTable
ALTER TABLE "Package" ADD COLUMN     "billingInterval" TEXT NOT NULL DEFAULT 'MONTH',
ADD COLUMN     "billingIntervalCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "productId" TEXT,
ADD COLUMN     "recurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sellingPlanGroupId" TEXT,
ADD COLUMN     "sellingPlanId" TEXT,
ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "CustomerPackage" ADD COLUMN     "billingAttemptId" TEXT,
ADD COLUMN     "billingFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "manageToken" TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
ADD COLUMN     "nextBillingDate" TIMESTAMP(3),
ADD COLUMN     "subscriptionContractId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPackage_manageToken_key" ON "CustomerPackage"("manageToken");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPackage_subscriptionContractId_key" ON "CustomerPackage"("subscriptionContractId");


ALTER TABLE "CustomerPackage" ALTER COLUMN "manageToken" DROP DEFAULT;
