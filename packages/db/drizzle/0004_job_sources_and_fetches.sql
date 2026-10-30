ALTER TABLE `job_fetches` ADD `last_modified` text;--> statement-breakpoint
ALTER TABLE `job_fetches` ADD `outcome` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE `job_fetches` ADD `error_message` text;--> statement-breakpoint
ALTER TABLE `job_fetches` ADD `item_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_fetches` ADD `skipped_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `job_fetches` ADD `new_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `job_source_id` text REFERENCES job_sources(id);--> statement-breakpoint
CREATE INDEX `jobs_source_idx` ON `jobs` (`job_source_id`);