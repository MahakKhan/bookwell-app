-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_staffId_fkey";

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "allowCustomerCancel" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowCustomerReschedule" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "apiKeyHash" TEXT,
ADD COLUMN     "apiKeyPrefix" TEXT,
ADD COLUMN     "autoCancelBookingOnOrderCancel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoCancelOrderOnAdminCancel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoCancelOrderOnCustomerCancel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoRefundOnAdminCancel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoRefundOnCustomerCancel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelCutoffHours" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "createOrderWithoutCheckout" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "dailyBookingLimit" INTEGER,
ADD COLUMN     "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "emailConfirmIntro" TEXT,
ADD COLUMN     "emailConfirmSubject" TEXT,
ADD COLUMN     "emailReminderHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "gaMeasurementId" TEXT,
ADD COLUMN     "globalBufferMinutes" INTEGER,
ADD COLUMN     "hideWidgetLogs" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "holdMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "klaviyoApiKey" TEXT,
ADD COLUMN     "maxPerSlot" INTEGER,
ADD COLUMN     "metaPixelId" TEXT,
ADD COLUMN     "multiLanguage" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyMerchantEmail" TEXT,
ADD COLUMN     "showSlotsLeft" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showStaffSelector" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tagCustomers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twilioWhatsappFrom" TEXT,
ADD COLUMN     "use24h" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "webhookSecret" TEXT,
ADD COLUMN     "webhookUrl" TEXT,
ADD COLUMN     "weekStartsOn" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "widgetButtonText" TEXT,
ADD COLUMN     "widgetRadius" INTEGER NOT NULL DEFAULT 12;

-- AlterTable
ALTER TABLE "StaffMember" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "canBookAnyService" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCreateBookings" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canEditAvailability" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hideContact" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hidePrices" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "portalAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "portalToken" TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "allowRecurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "color" TEXT NOT NULL DEFAULT '#5b5bd6',
ADD COLUMN     "dailyLimit" INTEGER,
ADD COLUMN     "depositValue" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "maxAdvanceDays" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "maxDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "maxQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "maxRecurrences" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "meetingUrl" TEXT,
ADD COLUMN     "minDays" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "minNoticeMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paymentMode" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resourceId" TEXT,
ADD COLUMN     "slotStepMinutes" INTEGER,
ADD COLUMN     "staffIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "staffMode" TEXT NOT NULL DEFAULT 'staff',
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'appointment',
ADD COLUMN     "waitlistEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "AvailabilityRule" ADD COLUMN     "serviceId" TEXT,
ALTER COLUMN "staffId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "addons" JSONB,
ADD COLUMN     "amountDue" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "answers" JSONB,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" TEXT,
ADD COLUMN     "checkoutUrl" TEXT,
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "draftOrderId" TEXT,
ADD COLUMN     "holdExpiresAt" TIMESTAMP(3),
ADD COLUMN     "meetingUrl" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "paymentStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "resourceId" TEXT,
ADD COLUMN     "seriesId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'widget',
ADD COLUMN     "totalPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
ALTER COLUMN "staffId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerLabel" TEXT,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'custom',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAddon" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "durationMinutes" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ServiceAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingQuestion" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "serviceId" TEXT,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BookingQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedTime" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "staffId" TEXT,
    "serviceId" TEXT,
    "resourceId" TEXT,
    "kind" TEXT NOT NULL,
    "startDate" TEXT,
    "endDate" TEXT,
    "weekday" INTEGER,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "label" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedTime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedEmail" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shopifyCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT,
    "date" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "bookingId" TEXT,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Resource_shopId_idx" ON "Resource"("shopId");

-- CreateIndex
CREATE INDEX "ServiceAddon_serviceId_idx" ON "ServiceAddon"("serviceId");

-- CreateIndex
CREATE INDEX "BookingQuestion_shopId_idx" ON "BookingQuestion"("shopId");

-- CreateIndex
CREATE INDEX "BlockedTime_shopId_idx" ON "BlockedTime"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedEmail_shopId_email_key" ON "BlockedEmail"("shopId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_shopId_email_key" ON "Customer"("shopId", "email");

-- CreateIndex
CREATE INDEX "WaitlistEntry_shopId_status_idx" ON "WaitlistEntry"("shopId", "status");

-- CreateIndex
CREATE INDEX "WaitlistEntry_serviceId_date_idx" ON "WaitlistEntry"("serviceId", "date");

-- CreateIndex
CREATE INDEX "NotificationLog_shopId_createdAt_idx" ON "NotificationLog"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_apiKeyHash_key" ON "Shop"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "StaffMember_portalToken_key" ON "StaffMember"("portalToken");

-- CreateIndex
CREATE INDEX "AvailabilityRule_serviceId_idx" ON "AvailabilityRule"("serviceId");

-- CreateIndex
CREATE INDEX "Booking_resourceId_startsAt_idx" ON "Booking"("resourceId", "startsAt");

-- CreateIndex
CREATE INDEX "Booking_customerId_idx" ON "Booking"("customerId");

-- CreateIndex
CREATE INDEX "Booking_shopId_status_idx" ON "Booking"("shopId", "status");

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAddon" ADD CONSTRAINT "ServiceAddon_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingQuestion" ADD CONSTRAINT "BookingQuestion_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingQuestion" ADD CONSTRAINT "BookingQuestion_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityRule" ADD CONSTRAINT "AvailabilityRule_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedTime" ADD CONSTRAINT "BlockedTime_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedTime" ADD CONSTRAINT "BlockedTime_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedTime" ADD CONSTRAINT "BlockedTime_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedTime" ADD CONSTRAINT "BlockedTime_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedEmail" ADD CONSTRAINT "BlockedEmail_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- portalToken got a random default only so existing rows could be filled;
-- new rows get a cuid from Prisma.
ALTER TABLE "StaffMember" ALTER COLUMN "portalToken" DROP DEFAULT;

-- Existing bookings: total price = service price at the time of migration.
UPDATE "Booking" b SET "totalPrice" = s.price FROM "Service" s WHERE s.id = b."serviceId" AND b."totalPrice" = 0;
