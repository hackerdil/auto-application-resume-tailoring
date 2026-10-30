-- Append-only and invariant guards enforced by SQLite itself (docs/DATA_MODEL.md, .claude/rules/database.md).
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifacts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER profile_versions_no_update BEFORE UPDATE ON profile_versions
BEGIN SELECT RAISE(ABORT, 'profile_versions are immutable'); END;
--> statement-breakpoint
-- Facts: the only permitted update is setting superseded_by once, to another existing fact.
CREATE TRIGGER facts_supersede_only BEFORE UPDATE ON facts
WHEN OLD.superseded_by IS NOT NULL
  OR NEW.superseded_by IS NULL
  OR NEW.superseded_by = OLD.id
  OR NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = NEW.superseded_by AND f.user_id = OLD.user_id)
  OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.category IS NOT OLD.category
  OR NEW.claim IS NOT OLD.claim OR NEW.source IS NOT OLD.source
  OR NEW.source_artifact_id IS NOT OLD.source_artifact_id OR NEW.source_location IS NOT OLD.source_location
  OR NEW.evidence_text IS NOT OLD.evidence_text OR NEW.verified_at IS NOT OLD.verified_at
  OR NEW.allowed_transformations IS NOT OLD.allowed_transformations OR NEW.sensitive IS NOT OLD.sensitive
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'facts are append-only; only superseded_by may be set, once'); END;
--> statement-breakpoint
CREATE TRIGGER facts_no_delete BEFORE DELETE ON facts
BEGIN SELECT RAISE(ABORT, 'facts are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER users_single_owner BEFORE INSERT ON users
WHEN (SELECT COUNT(*) FROM users) >= 1
BEGIN SELECT RAISE(ABORT, 'only one local owner is supported'); END;
--> statement-breakpoint
-- A consumed or revoked approval can never be reactivated or re-consumed.
CREATE TRIGGER application_approvals_final BEFORE UPDATE ON application_approvals
WHEN (OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL)
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.binding_json IS NOT OLD.binding_json
  OR NEW.binding_mac IS NOT OLD.binding_mac OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.application_id IS NOT OLD.application_id
BEGIN SELECT RAISE(ABORT, 'approvals are single-use and immutable once consumed or revoked'); END;
--> statement-breakpoint
-- Terminal application states never change; SUBMITTED cannot be re-entered.
CREATE TRIGGER applications_terminal BEFORE UPDATE OF state ON applications
WHEN OLD.state IN ('SUBMITTED', 'FAILED', 'WITHDRAWN') AND NEW.state IS NOT OLD.state
BEGIN SELECT RAISE(ABORT, 'application is in a terminal state'); END;
