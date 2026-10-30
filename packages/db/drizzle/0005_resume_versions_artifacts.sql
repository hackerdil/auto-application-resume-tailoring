ALTER TABLE `resume_versions` ADD `length` text DEFAULT 'one-page' NOT NULL;--> statement-breakpoint
ALTER TABLE `resume_versions` ADD `html_artifact_id` text REFERENCES artifacts(id);--> statement-breakpoint
ALTER TABLE `resume_versions` ADD `pdf_artifact_id` text REFERENCES artifacts(id);--> statement-breakpoint
ALTER TABLE `resume_versions` ADD `docx_artifact_id` text REFERENCES artifacts(id);--> statement-breakpoint
ALTER TABLE `resume_versions` ADD `checks` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `resume_versions` ADD `decided_at` integer;--> statement-breakpoint
CREATE INDEX `resume_versions_job_idx` ON `resume_versions` (`job_id`,`created_at`);