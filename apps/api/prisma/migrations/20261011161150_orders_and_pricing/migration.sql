-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('processing', 'pending', 'accepted', 'printing', 'completed', 'rejected', 'failed', 'expired');

-- CreateTable
CREATE TABLE "shop_rates" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "paper_size" TEXT NOT NULL,
    "color_mode" TEXT NOT NULL,
    "sides" TEXT NOT NULL,
    "price_per_side_paise" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_pricing" (
    "shop_id" UUID NOT NULL,
    "minimum_charge_paise" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_pricing_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "queue_date" TEXT NOT NULL,
    "queue_number" INTEGER NOT NULL,
    "lookup_token_hash" TEXT NOT NULL,
    "customer_name" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'processing',
    "estimated_amount_paise" INTEGER NOT NULL,
    "final_amount_paise" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "rate_snapshot" JSONB NOT NULL,
    "rejection_reason" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "files_purged_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "upload_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "original_name" TEXT NOT NULL,
    "page_count" INTEGER NOT NULL,
    "print_settings" JSONB NOT NULL,
    "selected_pages" JSONB NOT NULL,
    "selected_page_count" INTEGER NOT NULL,
    "printed_sides" INTEGER NOT NULL,
    "sheets" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "print_pdf_key" TEXT,
    "print_pdf_bytes" INTEGER,
    "print_pdf_pages" INTEGER,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_counters" (
    "shop_id" UUID NOT NULL,
    "date_key" TEXT NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_counters_pkey" PRIMARY KEY ("shop_id","date_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_rates_shop_id_paper_size_color_mode_sides_key" ON "shop_rates"("shop_id", "paper_size", "color_mode", "sides");

-- CreateIndex
CREATE UNIQUE INDEX "orders_lookup_token_hash_key" ON "orders"("lookup_token_hash");

-- CreateIndex
CREATE INDEX "orders_shop_id_status_created_at_idx" ON "orders"("shop_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_expires_at_idx" ON "orders"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shop_id_queue_date_queue_number_key" ON "orders"("shop_id", "queue_date", "queue_number");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_upload_id_key" ON "order_items"("upload_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_shop_id_idx" ON "order_items"("shop_id");

-- AddForeignKey
ALTER TABLE "shop_rates" ADD CONSTRAINT "shop_rates_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_pricing" ADD CONSTRAINT "shop_pricing_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
