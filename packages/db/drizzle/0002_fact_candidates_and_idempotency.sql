CREATE TABLE `document_texts` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`text_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fact_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`category` text NOT NULL,
	`claim_enc` text NOT NULL,
	`evidence_enc` text NOT NULL,
	`source_location` text,
	`extractor` text NOT NULL,
	`sensitive` integer NOT NULL,
	`status` text NOT NULL,
	`fact_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fact_candidates_status_ck" CHECK(status IN ('pending', 'confirmed', 'rejected')),
	CONSTRAINT "fact_candidates_decision_ck" CHECK((status = 'pending' AND fact_id IS NULL AND decided_at IS NULL) OR (status = 'confirmed' AND fact_id IS NOT NULL AND decided_at IS NOT NULL) OR (status = 'rejected' AND fact_id IS NULL AND decided_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `fact_candidates_user_status_idx` ON `fact_candidates` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`request_hash` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_enc` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_key_scope_uq` ON `idempotency_keys` (`key`,`scope`);