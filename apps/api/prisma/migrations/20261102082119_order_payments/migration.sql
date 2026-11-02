-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'upi', 'card');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "paid_amount_paise" INTEGER,
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "payment_method" "PaymentMethod";

-- CreateIndex
CREATE INDEX "orders_shop_id_queue_date_idx" ON "orders"("shop_id", "queue_date");
