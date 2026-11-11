-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "planName" TEXT NOT NULL DEFAULT 'free',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoWaySyncOn" BOOLEAN NOT NULL DEFAULT false,
    "widgetAccent" TEXT NOT NULL DEFAULT '#5b5bd6',
    "notifyFromEmail" TEXT,
    "resendApiKey" TEXT,
    "twilioAccountSid" TEXT,
    "twilioAuthToken" TEXT,
    "twilioFromNumber" TEXT,
    "googleRefreshToken" TEXT,
    "googleAccessToken" TEXT,
    "googleTokenExpiry" TIMESTAMP(3),
    "googleCalendarId" TEXT DEFAULT 'primary',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffMember" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "color" TEXT NOT NULL DEFAULT '#5b5bd6',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "price" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "requiresDeposit" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityRule" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "AvailabilityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "locationId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT,
    "smsOptIn" BOOLEAN NOT NULL DEFAULT false,
    "shopifyOrderId" TEXT,
    "depositPaid" DECIMAL(65,30) DEFAULT 0,
    "manageToken" TEXT NOT NULL,
    "googleEventId" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingReconciliation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedCharges" INTEGER NOT NULL,
    "confirmedCharges" INTEGER NOT NULL,
    "mismatches" INTEGER NOT NULL,
    "details" TEXT,

    CONSTRAINT "BillingReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Location_shopId_idx" ON "Location"("shopId");

-- CreateIndex
CREATE INDEX "StaffMember_shopId_idx" ON "StaffMember"("shopId");

-- CreateIndex
CREATE INDEX "Service_shopId_idx" ON "Service"("shopId");

-- CreateIndex
CREATE INDEX "Service_productId_idx" ON "Service"("productId");

-- CreateIndex
CREATE INDEX "AvailabilityRule_staffId_idx" ON "AvailabilityRule"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_manageToken_key" ON "Booking"("manageToken");

-- CreateIndex
CREATE INDEX "Booking_shopId_startsAt_idx" ON "Booking"("shopId", "startsAt");

-- CreateIndex
CREATE INDEX "Booking_serviceId_idx" ON "Booking"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_staffId_startsAt_key" ON "Booking"("staffId", "startsAt");

-- CreateIndex
CREATE INDEX "BillingReconciliation_shopId_ranAt_idx" ON "BillingReconciliation"("shopId", "ranAt");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingReconciliation" ADD CONSTRAINT "BillingReconciliation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
