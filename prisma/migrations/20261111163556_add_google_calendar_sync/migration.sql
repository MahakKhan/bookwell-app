-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "googleEventId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "googleAccessToken" TEXT;
ALTER TABLE "Shop" ADD COLUMN "googleCalendarId" TEXT DEFAULT 'primary';
ALTER TABLE "Shop" ADD COLUMN "googleRefreshToken" TEXT;
ALTER TABLE "Shop" ADD COLUMN "googleTokenExpiry" DATETIME;
