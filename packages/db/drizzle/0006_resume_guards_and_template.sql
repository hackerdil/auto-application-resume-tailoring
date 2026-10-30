-- Résumé versions are immutable records of what was generated and verified (spec §11, §15 step 13).
CREATE TRIGGER resume_versions_status_valid BEFORE INSERT ON resume_versions
WHEN NEW.status NOT IN ('draft', 'needs_attention', 'approved', 'rejected')
BEGIN SELECT RAISE(ABORT, 'invalid resume status'); END;
--> statement-breakpoint
-- The only permitted change: a draft is approved or rejected once (status + decided_at).
CREATE TRIGGER resume_versions_immutable BEFORE UPDATE ON resume_versions
WHEN NOT (OLD.status = 'draft' AND NEW.status IN ('approved', 'rejected') AND NEW.decided_at IS NOT NULL)
  OR NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.profile_version IS NOT OLD.profile_version
  OR NEW.template_id IS NOT OLD.template_id OR NEW.structured IS NOT OLD.structured OR NEW.length IS NOT OLD.length
  OR NEW.html_artifact_id IS NOT OLD.html_artifact_id OR NEW.pdf_artifact_id IS NOT OLD.pdf_artifact_id
  OR NEW.docx_artifact_id IS NOT OLD.docx_artifact_id OR NEW.checks IS NOT OLD.checks OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'resume versions are immutable; only a draft can be approved or rejected'); END;
--> statement-breakpoint
CREATE TRIGGER resume_versions_no_delete BEFORE DELETE ON resume_versions
BEGIN SELECT RAISE(ABORT, 'resume versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER resume_bullets_no_update BEFORE UPDATE ON resume_bullets
BEGIN SELECT RAISE(ABORT, 'resume bullets are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER resume_bullets_no_delete BEFORE DELETE ON resume_bullets
BEGIN SELECT RAISE(ABORT, 'resume bullets are immutable'); END;
--> statement-breakpoint
INSERT INTO resume_templates (id, name, version, created_at) VALUES ('0190f0b0-0000-7000-8000-00000000c001', 'classic', '1', 0);
