CREATE TYPE "public"."pipeline_state" AS ENUM('candidate', 'referral_pending', 'ready_to_apply', 'applied', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_pipeline_state" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"state" "pipeline_state" NOT NULL,
	"entered_state_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_pipeline_state" ADD CONSTRAINT "job_pipeline_state_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_pipeline_state_state_idx" ON "job_pipeline_state" USING btree ("state","entered_state_at");