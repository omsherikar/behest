CREATE TYPE "public"."mandate_confirmation" AS ENUM('session', 'passkey');--> statement-breakpoint
CREATE TABLE "buyer_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "buyer_passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "confirmation" "mandate_confirmation" DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandates" ADD COLUMN "buyer_assertion" jsonb;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "decision_record" jsonb;--> statement-breakpoint
ALTER TABLE "buyer_passkeys" ADD CONSTRAINT "buyer_passkeys_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buyer_passkeys_buyer_idx" ON "buyer_passkeys" USING btree ("buyer_id");