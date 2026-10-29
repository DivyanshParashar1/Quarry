CREATE TYPE "public"."sent_email_status" AS ENUM('queued', 'sent', 'dry_run', 'scheduled', 'cancelled', 'failed');--> statement-breakpoint
ALTER TYPE "public"."review_kind" ADD VALUE 'compose';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sent_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_item_id" uuid,
	"source" text NOT NULL,
	"status" "sent_email_status" NOT NULL,
	"from_address" text,
	"to_address" text NOT NULL,
	"to_name" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_id" text,
	"gmail_id" text,
	"gmail_thread_id" text,
	"gmail_draft_id" text,
	"scheduled_for" timestamp with time zone,
	"contact_id" uuid,
	"company_id" uuid,
	"job_id" uuid,
	"thread_id" uuid,
	"batch_key" uuid,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original" jsonb,
	"dry_run" boolean DEFAULT false NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sent_emails" ADD CONSTRAINT "sent_emails_thread_id_outreach_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."outreach_threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sent_emails_review_item_uniq" ON "sent_emails" USING btree ("review_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sent_emails_created_idx" ON "sent_emails" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sent_emails_to_idx" ON "sent_emails" USING btree (lower("to_address"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sent_emails_status_idx" ON "sent_emails" USING btree ("status");--> statement-breakpoint
-- Backfill: every email sent before the log existed (live, succeeded sends of the Gmail actor).
INSERT INTO "sent_emails" ("review_item_id", "source", "status", "to_address", "to_name", "subject", "body", "attachments",
  "message_id", "gmail_id", "gmail_thread_id", "contact_id", "company_id", "job_id", "thread_id", "input", "original", "dry_run", "sent_at", "created_at")
SELECT DISTINCT ON (r.id)
  r.id, r.kind::text, 'sent', coalesce(r.draft->>'to', ''), r.draft->>'toName', coalesce(r.draft->>'subject', ''), coalesce(r.draft->>'body', ''),
  coalesce((SELECT jsonb_agg(jsonb_build_object('filename', a->>'filename', 'contentType', a->>'contentType', 'path', a->>'path'))
            FROM jsonb_array_elements(coalesce(r.draft->'attachments', '[]'::jsonb)) a), '[]'::jsonb),
  x.result->>'messageId', x.result->>'gmailId', x.result->>'gmailThreadId', r.contact_id, r.company_id, r.job_id,
  coalesce(r.thread_id, (SELECT t.id FROM outreach_threads t WHERE t.review_item_id = r.id LIMIT 1)),
  jsonb_build_object('backfilled', true, 'factIds', coalesce(r.draft->'factIds', '[]'::jsonb), 'confidence', r.draft->'confidence', 'decidedBy', r.decided_by),
  r.original_draft, false, coalesce(x.executed_at, r.updated_at), coalesce(x.executed_at, r.updated_at)
FROM "actions" x
JOIN "review_items" r ON r.id = x.review_item_id
WHERE x.plugin_id = 'actor-gmail-outreach' AND x.status = 'succeeded' AND x.dry_run = false
ORDER BY r.id, x.executed_at DESC
ON CONFLICT DO NOTHING;
