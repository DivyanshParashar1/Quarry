ALTER TABLE "jobs" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "inferred_deadline" date;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "deadline_confidence" real;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "deadline_rationale" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "deadline_sources" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "deadline_inferred_at" timestamp with time zone;