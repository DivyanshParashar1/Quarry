CREATE TABLE IF NOT EXISTS "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"expert" text,
	"diagnosis" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"evidence_at" timestamp with time zone,
	"acted_at" timestamp with time zone,
	"verify_until" timestamp with time zone,
	"llm_cost_usd" real DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incidents_open_fingerprint_uniq" ON "incidents" USING btree ("fingerprint") WHERE status <> 'resolved';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_status_idx" ON "incidents" USING btree ("status","updated_at");