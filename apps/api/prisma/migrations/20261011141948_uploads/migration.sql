-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('processing', 'ready', 'failed');

-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "detected_mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'processing',
    "error_code" TEXT,
    "error_message" TEXT,
    "page_count" INTEGER,
    "original_key" TEXT,
    "normalized_key" TEXT,
    "normalized_size_bytes" INTEGER,
    "conversion_settings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "files_purged_at" TIMESTAMP(3),

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uploads_token_hash_key" ON "uploads"("token_hash");

-- CreateIndex
CREATE INDEX "uploads_shop_id_created_at_idx" ON "uploads"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "uploads_expires_at_idx" ON "uploads"("expires_at");

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
