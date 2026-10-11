CREATE TYPE "public"."contact_import_status" AS ENUM('preview', 'committed', 'discarded');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"format" text NOT NULL,
	"status" "contact_import_status" DEFAULT 'preview' NOT NULL,
	"report" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "linkedin_degree" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "connected_on" date;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "import_id" uuid;