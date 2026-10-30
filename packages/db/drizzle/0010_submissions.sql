CREATE TABLE `submission_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`outcome` text,
	`evidence` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `application_approvals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_attempts_approval_id_unique` ON `submission_attempts` (`approval_id`);--> statement-breakpoint
ALTER TABLE `browser_sessions` ADD `review` text;--> statement-breakpoint
CREATE TRIGGER submission_attempts_outcome_valid BEFORE UPDATE OF outcome ON submission_attempts
WHEN NEW.outcome IS NOT NULL AND NEW.outcome NOT IN ('submitted', 'uncertain', 'rejected_before_send', 'failed')
BEGIN SELECT RAISE(ABORT, 'submission_attempts.outcome is invalid'); END;--> statement-breakpoint
CREATE TRIGGER submission_attempts_final BEFORE UPDATE ON submission_attempts
WHEN OLD.ended_at IS NOT NULL OR NEW.application_id IS NOT OLD.application_id OR NEW.approval_id IS NOT OLD.approval_id OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'submission attempts are append-only once finished'); END;--> statement-breakpoint
CREATE TRIGGER submission_attempts_no_delete BEFORE DELETE ON submission_attempts
BEGIN SELECT RAISE(ABORT, 'submission attempts cannot be deleted'); END;--> statement-breakpoint
CREATE TRIGGER submission_attempts_needs_consumed_approval BEFORE INSERT ON submission_attempts
WHEN (SELECT consumed_at FROM application_approvals WHERE id = NEW.approval_id) IS NULL
BEGIN SELECT RAISE(ABORT, 'a submission attempt needs a consumed approval'); END;
