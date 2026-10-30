CREATE TRIGGER cover_letter_versions_status_valid BEFORE INSERT ON cover_letter_versions
WHEN NEW.status NOT IN ('draft', 'needs_attention', 'approved', 'rejected')
BEGIN SELECT RAISE(ABORT, 'invalid cover letter status'); END;
--> statement-breakpoint
CREATE TRIGGER cover_letter_versions_immutable BEFORE UPDATE ON cover_letter_versions
WHEN NOT (OLD.status = 'draft' AND NEW.status IN ('approved', 'rejected') AND NEW.decided_at IS NOT NULL)
  OR NEW.id IS NOT OLD.id OR NEW.application_id IS NOT OLD.application_id OR NEW.job_id IS NOT OLD.job_id
  OR NEW.structured IS NOT OLD.structured OR NEW.text IS NOT OLD.text OR NEW.html_artifact_id IS NOT OLD.html_artifact_id
  OR NEW.pdf_artifact_id IS NOT OLD.pdf_artifact_id OR NEW.docx_artifact_id IS NOT OLD.docx_artifact_id
  OR NEW.checks IS NOT OLD.checks OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'cover letter versions are immutable; only a draft can be approved or rejected'); END;
--> statement-breakpoint
CREATE TRIGGER cover_letter_versions_no_delete BEFORE DELETE ON cover_letter_versions
BEGIN SELECT RAISE(ABORT, 'cover letter versions are immutable'); END;
--> statement-breakpoint
-- A field is what the form (or the owner) asked; it never changes after it is recorded.
CREATE TRIGGER application_fields_no_update BEFORE UPDATE ON application_fields
BEGIN SELECT RAISE(ABORT, 'application fields are immutable'); END;
--> statement-breakpoint
-- needs_review answers, like requires_user ones, are finalized only by the owner.
CREATE TRIGGER application_answers_review_user_only_ins BEFORE INSERT ON application_answers
WHEN NEW.decision = 'needs_review' AND NEW.final_value_enc IS NOT NULL AND NEW.final_value_set_by IS NOT 'user'
BEGIN SELECT RAISE(ABORT, 'needs_review answers can only be finalized by the user'); END;
--> statement-breakpoint
CREATE TRIGGER application_answers_review_user_only_upd BEFORE UPDATE ON application_answers
WHEN NEW.decision = 'needs_review' AND NEW.final_value_enc IS NOT NULL AND NEW.final_value_set_by IS NOT 'user'
BEGIN SELECT RAISE(ABORT, 'needs_review answers can only be finalized by the user'); END;
