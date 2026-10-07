ALTER TYPE "public"."ats_type" ADD VALUE 'workday';--> statement-breakpoint
ALTER TYPE "public"."ats_type" ADD VALUE 'smartrecruiters';--> statement-breakpoint
ALTER TYPE "public"."ats_type" ADD VALUE 'successfactors';--> statement-breakpoint
ALTER TYPE "public"."ats_type" ADD VALUE 'taleo';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "discovered_via" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "ats_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_sources" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_sources" ADD COLUMN "detected_by" text;