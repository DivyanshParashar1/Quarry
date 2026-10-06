CREATE TYPE "public"."ats_type" AS ENUM('greenhouse', 'lever', 'ashby', 'careers_page', 'other');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'paused', 'error');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"location" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ats_type" "ats_type" NOT NULL,
	"board_token" text,
	"status" "source_status" DEFAULT 'active' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"remote_policy" text,
	"seniority" text,
	"description_md" text,
	"apply_url" text,
	"fingerprint" text NOT NULL,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plugin_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"target_key" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"items_in" integer DEFAULT 0 NOT NULL,
	"items_out" integer DEFAULT 0 NOT NULL,
	"error" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_plugin" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"payload" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"canonical_job_id" uuid,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_sources" ADD CONSTRAINT "company_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_postings" ADD CONSTRAINT "raw_postings_canonical_job_id_jobs_id_fk" FOREIGN KEY ("canonical_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_name_uniq" ON "companies" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_domain_idx" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_sources_company_ats_token_uniq" ON "company_sources" USING btree ("company_id","ats_type","board_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_kind_idx" ON "events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_created_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_fingerprint_uniq" ON "jobs" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_company_idx" ON "jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_runs_plugin_idx" ON "plugin_runs" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_runs_started_idx" ON "plugin_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "raw_postings_source_external_uniq" ON "raw_postings" USING btree ("source_plugin","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_postings_fingerprint_idx" ON "raw_postings" USING btree ("fingerprint");