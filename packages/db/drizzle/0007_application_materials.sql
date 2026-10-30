CREATE TABLE `cover_letter_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`job_id` text NOT NULL,
	`structured` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`html_artifact_id` text,
	`pdf_artifact_id` text,
	`docx_artifact_id` text,
	`checks` text DEFAULT '[]' NOT NULL,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`html_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pdf_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`docx_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cover_letter_versions_app_idx` ON `cover_letter_versions` (`application_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `application_answers` ADD `notes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_fields` ADD `category` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `application_fields` ADD `origin` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` ADD `resume_version_id` text REFERENCES resume_versions(id);--> statement-breakpoint
ALTER TABLE `applications` ADD `cover_letter_version_id` text REFERENCES cover_letter_versions(id);--> statement-breakpoint
ALTER TABLE `applications` ADD `cover_letter_skipped` integer DEFAULT false NOT NULL;