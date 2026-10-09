CREATE TYPE "public"."resume_kind" AS ENUM('generated', 'combo', 'base', 'tailored');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_resume" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"variant_id" uuid NOT NULL,
	"combo_variant_id" uuid,
	"selector_score" real,
	"decision" jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resume_benchmark_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"title_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resume_benchmark_jobs" (
	"category_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_benchmark_jobs_category_id_job_id_pk" PRIMARY KEY("category_id","job_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resume_benchmark_scores" (
	"variant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"scores" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_benchmark_scores_variant_id_job_id_pk" PRIMARY KEY("variant_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "resume_variants" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "kind" "resume_kind" DEFAULT 'generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "combo_key" text;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "parent_variant_id" uuid;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "ats_score" jsonb;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "resume_text" text;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_resume" ADD CONSTRAINT "job_resume_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_resume" ADD CONSTRAINT "job_resume_variant_id_resume_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."resume_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_resume" ADD CONSTRAINT "job_resume_combo_variant_id_resume_variants_id_fk" FOREIGN KEY ("combo_variant_id") REFERENCES "public"."resume_variants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resume_benchmark_jobs" ADD CONSTRAINT "resume_benchmark_jobs_category_id_resume_benchmark_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."resume_benchmark_categories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resume_benchmark_jobs" ADD CONSTRAINT "resume_benchmark_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resume_benchmark_scores" ADD CONSTRAINT "resume_benchmark_scores_variant_id_resume_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."resume_variants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resume_benchmark_scores" ADD CONSTRAINT "resume_benchmark_scores_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resume_variants" ADD CONSTRAINT "resume_variants_parent_variant_id_resume_variants_id_fk" FOREIGN KEY ("parent_variant_id") REFERENCES "public"."resume_variants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resume_variants_library_idx" ON "resume_variants" USING btree ("kind","retired_at");