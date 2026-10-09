ALTER TYPE "public"."resume_status" ADD VALUE 'overflow';--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "fit" jsonb;