ALTER TABLE "contacts" ADD COLUMN "bounced_emails" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "contacts" SET "bounced_emails" = ARRAY[lower("email")] WHERE "status" = 'bounced' AND "email" IS NOT NULL;
