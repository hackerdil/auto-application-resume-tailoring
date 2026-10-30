ALTER TABLE `browser_sessions` ADD `adapter` text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE `browser_sessions` ADD `handoff_reason` text;--> statement-breakpoint
ALTER TABLE `browser_sessions` ADD `steps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `browser_sessions` ADD `last_url` text;--> statement-breakpoint
CREATE TRIGGER browser_sessions_status_valid BEFORE INSERT ON browser_sessions
WHEN NEW.status NOT IN ('active', 'handoff', 'awaiting_input', 'ready', 'closed', 'failed')
BEGIN SELECT RAISE(ABORT, 'browser_sessions.status is invalid'); END;--> statement-breakpoint
CREATE TRIGGER browser_sessions_status_valid_upd BEFORE UPDATE OF status ON browser_sessions
WHEN NEW.status NOT IN ('active', 'handoff', 'awaiting_input', 'ready', 'closed', 'failed')
BEGIN SELECT RAISE(ABORT, 'browser_sessions.status is invalid'); END;--> statement-breakpoint
CREATE TRIGGER browser_sessions_ended_final BEFORE UPDATE ON browser_sessions
WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'browser_sessions: an ended session cannot change'); END;
