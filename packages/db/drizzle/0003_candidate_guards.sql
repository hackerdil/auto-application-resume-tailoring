-- Candidate decisions are final: once confirmed or rejected, a candidate never changes again.
CREATE TRIGGER fact_candidates_decided_final BEFORE UPDATE ON fact_candidates
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT, 'candidate decision is final'); END;
--> statement-breakpoint
CREATE TRIGGER idempotency_keys_no_update BEFORE UPDATE ON idempotency_keys
BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
