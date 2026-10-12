-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('queued', 'sent', 'printing', 'done', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "agent_devices" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "version" TEXT,
    "printers" JSONB,
    "last_seen_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_pairings" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_printers" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "color_mode" TEXT NOT NULL,
    "printer_name" TEXT NOT NULL,
    "supports_duplex" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_printers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "order_id" UUID,
    "order_item_id" UUID,
    "label" TEXT NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'queued',
    "file_key" TEXT NOT NULL,
    "file_bytes" INTEGER,
    "spec" JSONB NOT NULL,
    "device_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_devices_token_hash_key" ON "agent_devices"("token_hash");

-- CreateIndex
CREATE INDEX "agent_devices_shop_id_idx" ON "agent_devices"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_pairings_code_hash_key" ON "agent_pairings"("code_hash");

-- CreateIndex
CREATE INDEX "agent_pairings_shop_id_idx" ON "agent_pairings"("shop_id");

-- CreateIndex
CREATE INDEX "agent_pairings_expires_at_idx" ON "agent_pairings"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "shop_printers_shop_id_color_mode_key" ON "shop_printers"("shop_id", "color_mode");

-- CreateIndex
CREATE INDEX "print_jobs_shop_id_status_idx" ON "print_jobs"("shop_id", "status");

-- CreateIndex
CREATE INDEX "print_jobs_order_id_idx" ON "print_jobs"("order_id");

-- AddForeignKey
ALTER TABLE "agent_devices" ADD CONSTRAINT "agent_devices_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_pairings" ADD CONSTRAINT "agent_pairings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_printers" ADD CONSTRAINT "shop_printers_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
