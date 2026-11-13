-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "googleBlockBusy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "textOverrides" JSONB;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "allowMultiSlot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoMeet" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxSlots" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "customerPackageId" TEXT;

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'pack',
    "credits" INTEGER,
    "validityDays" INTEGER NOT NULL DEFAULT 365,
    "price" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "serviceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPackage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "creditsLeft" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL DEFAULT 'storefront',
    "draftOrderId" TEXT,
    "checkoutUrl" TEXT,
    "shopifyOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalBusy" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'google',

    CONSTRAINT "ExternalBusy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Package_shopId_idx" ON "Package"("shopId");

-- CreateIndex
CREATE INDEX "CustomerPackage_shopId_customerEmail_idx" ON "CustomerPackage"("shopId", "customerEmail");

-- CreateIndex
CREATE INDEX "CustomerPackage_shopId_status_idx" ON "CustomerPackage"("shopId", "status");

-- CreateIndex
CREATE INDEX "ExternalBusy_shopId_startsAt_idx" ON "ExternalBusy"("shopId", "startsAt");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerPackageId_fkey" FOREIGN KEY ("customerPackageId") REFERENCES "CustomerPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPackage" ADD CONSTRAINT "CustomerPackage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPackage" ADD CONSTRAINT "CustomerPackage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPackage" ADD CONSTRAINT "CustomerPackage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalBusy" ADD CONSTRAINT "ExternalBusy_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

