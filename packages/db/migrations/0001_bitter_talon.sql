ALTER TABLE "raw_postings" ADD COLUMN "company_source_id" uuid;--> statement-breakpoint
ALTER TABLE "raw_postings" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_postings" ADD CONSTRAINT "raw_postings_company_source_id_company_sources_id_fk" FOREIGN KEY ("company_source_id") REFERENCES "public"."company_sources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_postings_company_source_idx" ON "raw_postings" USING btree ("company_source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_postings_canonical_job_idx" ON "raw_postings" USING btree ("canonical_job_id");