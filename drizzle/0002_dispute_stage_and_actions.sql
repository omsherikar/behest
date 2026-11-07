ALTER TABLE "disputes" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "actions" jsonb;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "messaged_at" timestamp with time zone;