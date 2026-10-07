CREATE TYPE "public"."referral_batch_status" AS ENUM('drafting', 'pending_review', 'sending', 'sent', 'replied', 'closed');--> statement-breakpoint
ALTER TYPE "public"."review_kind" ADD VALUE 'referral_ask';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_referral_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"requested_count" integer DEFAULT 10 NOT NULL,
	"drafted_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"replied_count" integer DEFAULT 0 NOT NULL,
	"status" "referral_batch_status" DEFAULT 'drafting' NOT NULL,
	"first_sent_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "linkedin_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "linkedin_slug" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "role_hint" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "seniority_hint" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_threads" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_referral_batches" ADD CONSTRAINT "job_referral_batches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_referral_batches_job_uniq" ON "job_referral_batches" USING btree ("job_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_items" ADD CONSTRAINT "review_items_batch_id_job_referral_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."job_referral_batches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_batch_idx" ON "review_items" USING btree ("batch_id");