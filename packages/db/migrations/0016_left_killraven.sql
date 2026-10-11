CREATE TABLE IF NOT EXISTS "answer_bank" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"question_key" text NOT NULL,
	"answer" text NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "answer_bank_key_uniq" ON "answer_bank" USING btree ("question_key","kind");