/*
  Warnings:

  - The `payment_method` column on the `orders` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('none', 'awaiting', 'paid', 'refunded', 'refund_failed');

-- CreateEnum
CREATE TYPE "OnlinePaymentStatus" AS ENUM ('awaiting', 'paid', 'refund_pending', 'refunded', 'refund_failed', 'abandoned');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_state" "PaymentState" NOT NULL DEFAULT 'none',
DROP COLUMN "payment_method",
ADD COLUMN     "payment_method" TEXT;

-- DropEnum
DROP TYPE "PaymentMethod";

-- CreateTable
CREATE TABLE "shop_payment_settings" (
    "shop_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "key_id" TEXT NOT NULL,
    "key_secret_enc" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_payment_settings_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "online_payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_order_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "status" "OnlinePaymentStatus" NOT NULL DEFAULT 'awaiting',
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT,
    "refund_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "online_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_order_id_key" ON "online_payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_provider_order_id_key" ON "online_payments"("provider_order_id");

-- CreateIndex
CREATE INDEX "online_payments_status_created_at_idx" ON "online_payments"("status", "created_at");

-- CreateIndex
CREATE INDEX "online_payments_shop_id_idx" ON "online_payments"("shop_id");

-- AddForeignKey
ALTER TABLE "shop_payment_settings" ADD CONSTRAINT "shop_payment_settings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
