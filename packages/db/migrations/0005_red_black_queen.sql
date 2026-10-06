ALTER TABLE "match_results" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "resume_variants" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "confidence" real;