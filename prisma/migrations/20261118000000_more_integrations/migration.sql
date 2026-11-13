-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "hubspotToken" TEXT,
ADD COLUMN     "icsToken" TEXT,
ADD COLUMN     "msAccessToken" TEXT,
ADD COLUMN     "msAccount" TEXT,
ADD COLUMN     "msRefreshToken" TEXT,
ADD COLUMN     "msTokenExpiry" TIMESTAMP(3),
ADD COLUMN     "outlookBlockBusy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outlookSyncOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "voiceGreeting" TEXT,
ADD COLUMN     "voiceInstructions" TEXT,
ADD COLUMN     "voiceToken" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "autoTeams" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "waiverId" TEXT;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "outlookEventId" TEXT;

-- CreateTable
CREATE TABLE "Waiver" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Waiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaiverSignature" (
    "id" TEXT NOT NULL,
    "waiverId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "waiverText" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaiverSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "callSid" TEXT NOT NULL,
    "caller" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Waiver_shopId_idx" ON "Waiver"("shopId");

-- CreateIndex
CREATE INDEX "WaiverSignature_bookingId_idx" ON "WaiverSignature"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_callSid_key" ON "CallSession"("callSid");

-- CreateIndex
CREATE INDEX "CallSession_shopId_createdAt_idx" ON "CallSession"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_icsToken_key" ON "Shop"("icsToken");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_voiceToken_key" ON "Shop"("voiceToken");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_waiverId_fkey" FOREIGN KEY ("waiverId") REFERENCES "Waiver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waiver" ADD CONSTRAINT "Waiver_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_waiverId_fkey" FOREIGN KEY ("waiverId") REFERENCES "Waiver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaiverSignature" ADD CONSTRAINT "WaiverSignature_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

