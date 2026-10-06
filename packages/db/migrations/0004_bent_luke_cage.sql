CREATE TYPE "public"."resume_status" AS ENUM('rendered', 'validation_failed', 'render_failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resume_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_version" text NOT NULL,
	"plugin_id" text NOT NULL,
	"template_id" text NOT NULL,
	"fact_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"bullets" jsonb NOT NULL,
	"header" jsonb NOT NULL,
	"validation_report" jsonb NOT NULL,
	"status" "resume_status" NOT NULL,
	"pdf_path" text,
	"pdf_bytes" integer,
	"provider" text,
	"model" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resume_variants" ADD CONSTRAINT "resume_variants_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resume_variants_job_idx" ON "resume_variants" USING btree ("job_id","created_at");