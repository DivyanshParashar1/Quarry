CREATE TYPE "public"."action_status" AS ENUM('started', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('active', 'bounced', 'do_not_contact');--> statement-breakpoint
CREATE TYPE "public"."review_kind" AS ENUM('application', 'outreach', 'followup');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'approved', 'rejected', 'executed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."thread_state" AS ENUM('sent', 'replied', 'bounced', 'closed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_item_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "action_status" NOT NULL,
	"dry_run" boolean NOT NULL,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"email" text,
	"email_confidence" real,
	"email_source" text,
	"linkedin_url" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" "contact_status" DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid,
	"job_id" uuid,
	"review_item_id" uuid,
	"gmail_thread_id" text NOT NULL,
	"subject" text NOT NULL,
	"message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" "thread_state" DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"followups_sent" integer DEFAULT 0 NOT NULL,
	"next_followup_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "review_kind" NOT NULL,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"plugin_id" text NOT NULL,
	"job_id" uuid,
	"contact_id" uuid,
	"company_id" uuid,
	"thread_id" uuid,
	"draft" jsonb NOT NULL,
	"original_draft" jsonb NOT NULL,
	"override_company_cap" boolean DEFAULT false NOT NULL,
	"not_before" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"edited_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "email_domain" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "mx_hosts" text[];--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "mx_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "email_pattern" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "email_pattern_confidence" real;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "actions" ADD CONSTRAINT "actions_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_threads" ADD CONSTRAINT "outreach_threads_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_items" ADD CONSTRAINT "review_items_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_items" ADD CONSTRAINT "review_items_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_items" ADD CONSTRAINT "review_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_items" ADD CONSTRAINT "review_items_thread_id_outreach_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."outreach_threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "actions_idempotency_key_uniq" ON "actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_review_item_idx" ON "actions" USING btree ("review_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_executed_idx" ON "actions" USING btree ("executed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_company_name_uniq" ON "contacts" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_email_idx" ON "contacts" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_threads_gmail_thread_uniq" ON "outreach_threads" USING btree ("gmail_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_threads_state_idx" ON "outreach_threads" USING btree ("state","next_followup_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_status_idx" ON "review_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_items_contact_idx" ON "review_items" USING btree ("contact_id");