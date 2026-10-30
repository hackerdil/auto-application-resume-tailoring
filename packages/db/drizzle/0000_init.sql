CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`limits` text NOT NULL,
	`counters` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`error_class` text,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_idempotency_key_unique` ON `agent_runs` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `application_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`proposed_value_enc` text,
	`final_value_enc` text,
	`final_value_set_by` text,
	`provenance` text NOT NULL,
	`confidence` real NOT NULL,
	`sensitivity` text NOT NULL,
	`decision` text NOT NULL,
	`reviewer_changes` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `application_fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "application_answers_decision_ck" CHECK(decision IN ('auto_fill', 'needs_review', 'requires_user', 'prohibited')),
	CONSTRAINT "application_answers_prohibited_empty_ck" CHECK(decision <> 'prohibited' OR final_value_enc IS NULL),
	CONSTRAINT "application_answers_user_only_ck" CHECK(decision <> 'requires_user' OR final_value_enc IS NULL OR final_value_set_by = 'user')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_answers_field_id_unique` ON `application_answers` (`field_id`);--> statement-breakpoint
CREATE TABLE `application_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`binding_json` text NOT NULL,
	`binding_mac` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`revoked_at` integer,
	`revoke_reason` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "application_approvals_not_both_ck" CHECK(consumed_at IS NULL OR revoked_at IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_approvals_one_active_uq` ON `application_approvals` (`application_id`) WHERE consumed_at IS NULL AND revoked_at IS NULL;--> statement-breakpoint
CREATE TABLE `application_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`field_key` text NOT NULL,
	`label` text NOT NULL,
	`normalized_question` text NOT NULL,
	`type` text NOT NULL,
	`required` integer NOT NULL,
	`options` text NOT NULL,
	`snapshot_generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_fields_key_uq` ON `application_fields` (`application_id`,`field_key`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "applications_state_ck" CHECK(state IN ('DRAFT', 'TAILORING', 'VERIFYING', 'READY_TO_PREPARE', 'PREPARING', 'AWAITING_USER_INPUT', 'READY_FOR_REVIEW', 'APPROVED_TO_SUBMIT', 'SUBMITTING', 'SUBMITTED', 'SUBMISSION_UNCERTAIN', 'FAILED', 'WITHDRAWN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_user_job_uq` ON `applications` (`user_id`,`job_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`kind` text NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_sha256_unique` ON `artifacts` (`sha256`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`trace_id` text NOT NULL,
	`run_id` text,
	`task_id` text,
	`application_id` text,
	`job_id` text,
	`actor` text NOT NULL,
	`type` text NOT NULL,
	`prev_state` text,
	`new_state` text,
	`approval_id` text,
	`artifact_hashes` text NOT NULL,
	`provider` text,
	`model` text,
	`duration_ms` integer,
	`metadata` text NOT NULL,
	CONSTRAINT "audit_events_actor_ck" CHECK(actor IN ('user', 'system', 'openai', 'claude', 'browser'))
);
--> statement-breakpoint
CREATE INDEX `audit_events_application_idx` ON `audit_events` (`application_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_trace_idx` ON `audit_events` (`trace_id`);--> statement-breakpoint
CREATE TABLE `browser_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text,
	`status` text NOT NULL,
	`origin_allowlist` text NOT NULL,
	`preserved` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `candidate_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`current_version` integer NOT NULL,
	`data_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidate_profiles_user_id_unique` ON `candidate_profiles` (`user_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_normalized_name_unique` ON `companies` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `fact_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`fact_id` text NOT NULL,
	`artifact_id` text,
	`location` text,
	`evidence_text` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`fact_id`) REFERENCES `facts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `facts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`claim` text NOT NULL,
	`source` text NOT NULL,
	`source_artifact_id` text,
	`source_location` text,
	`evidence_text` text,
	`verified_at` integer NOT NULL,
	`superseded_by` text,
	`allowed_transformations` text NOT NULL,
	`sensitive` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "facts_source_ck" CHECK(source IN ('resume', 'user-confirmed', 'imported-document'))
);
--> statement-breakpoint
CREATE INDEX `facts_user_active_idx` ON `facts` (`user_id`,`superseded_by`);--> statement-breakpoint
CREATE TABLE `follow_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`due_at` integer NOT NULL,
	`done_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_fetches` (
	`id` text PRIMARY KEY NOT NULL,
	`job_source_id` text,
	`url` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`http_status` integer,
	`etag` text,
	`raw_hash` text,
	`error_class` text,
	`duration_ms` integer,
	FOREIGN KEY (`job_source_id`) REFERENCES `job_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`requirement_key` text NOT NULL,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`evidence` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_requirements_job_key_uq` ON `job_requirements` (`job_id`,`requirement_key`);--> statement-breakpoint
CREATE TABLE `job_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`identifier` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`origin_allowlist` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_sources_type_identifier_uq` ON `job_sources` (`type`,`identifier`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`company_id` text,
	`data` text NOT NULL,
	`status` text NOT NULL,
	`source_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_status_ck" CHECK(status IN ('DISCOVERED', 'NORMALIZED', 'FILTERED', 'ELIGIBLE', 'SCORED', 'SHORTLISTED', 'SKIPPED', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_source_external_uq` ON `jobs` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `jobs_content_hash_idx` ON `jobs` (`content_hash`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `match_results` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`profile_version` integer NOT NULL,
	`scoring_version` text NOT NULL,
	`total` real NOT NULL,
	`verdict` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_results_uq` ON `match_results` (`job_id`,`profile_version`,`scoring_version`);--> statement-breakpoint
CREATE TABLE `profile_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`data_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `candidate_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_versions_profile_version_uq` ON `profile_versions` (`profile_id`,`version`);--> statement-breakpoint
CREATE TABLE `provider_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`agent_run_id` text,
	`provider` text NOT NULL,
	`model` text,
	`task_type` text NOT NULL,
	`prompt_id` text,
	`prompt_version` text,
	`request_id` text,
	`duration_ms` integer NOT NULL,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`reasoning_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`delegated` integer DEFAULT false NOT NULL,
	`fallback` integer DEFAULT false NOT NULL,
	`error_class` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `provider_runs_trace_idx` ON `provider_runs` (`trace_id`);--> statement-breakpoint
CREATE TABLE `resume_bullets` (
	`id` text PRIMARY KEY NOT NULL,
	`resume_version_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`source_fact_ids` text NOT NULL,
	`target_requirement_keys` text NOT NULL,
	`transformation` text NOT NULL,
	`deterministic_status` text NOT NULL,
	`review_status` text NOT NULL,
	`findings` text NOT NULL,
	FOREIGN KEY (`resume_version_id`) REFERENCES `resume_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "resume_bullets_has_facts_ck" CHECK(json_array_length(source_fact_ids) >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resume_bullets_ordinal_uq` ON `resume_bullets` (`resume_version_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `resume_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resume_templates_name_unique` ON `resume_templates` (`name`);--> statement-breakpoint
CREATE TABLE `resume_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`profile_version` integer NOT NULL,
	`template_id` text,
	`structured` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `resume_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `saved_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`normalized_question` text NOT NULL,
	`value_enc` text NOT NULL,
	`sensitivity` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_answers_active_uq` ON `saved_answers` (`user_id`,`normalized_question`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`available_at` integer NOT NULL,
	`last_error_class` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "tasks_status_ck" CHECK(status IN ('queued', 'leased', 'done', 'failed', 'needs_human'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_idempotency_key_unique` ON `tasks` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `tasks_claim_idx` ON `tasks` (`status`,`available_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
