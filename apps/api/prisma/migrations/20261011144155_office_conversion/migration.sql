-- AlterTable
ALTER TABLE "uploads" ADD COLUMN     "conversion_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "conversion_variants" JSONB,
ADD COLUMN     "document_kind" TEXT NOT NULL DEFAULT 'pdf',
ADD COLUMN     "office_family" TEXT;
