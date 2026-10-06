CREATE TYPE "public"."fact_kind" AS ENUM('project', 'experience', 'education', 'skill', 'achievement');--> statement-breakpoint
CREATE TYPE "public"."match_method" AS ENUM('filtered', 'prefilter', 'llm');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"success" boolean NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real,
	"latency_ms" integer NOT NULL,
	"error" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "match_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_version" text NOT NULL,
	"plugin_id" text NOT NULL,
	"method" "match_method" NOT NULL,
	"score" integer NOT NULL,
	"similarity" real,
	"rubric" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reasons" text NOT NULL,
	"provider" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "fact_kind" NOT NULL,
	"content" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(384),
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_snapshots" (
	"version" text PRIMARY KEY NOT NULL,
	"preferences" jsonb NOT NULL,
	"fact_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary" text NOT NULL,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "match_results" ADD CONSTRAINT "match_results_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_task_idx" ON "llm_calls" USING btree ("task");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "match_results_job_profile_uniq" ON "match_results" USING btree ("job_id","profile_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "match_results_profile_score_idx" ON "match_results" USING btree ("profile_version","score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_facts_kind_idx" ON "profile_facts" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_embedding_idx" ON "jobs" USING hnsw ("embedding" vector_cosine_ops);