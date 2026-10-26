CREATE TABLE `hub_check_outbox` (
	`check_id` text PRIMARY KEY NOT NULL,
	`acked_at` integer
);
--> statement-breakpoint
CREATE TABLE `hub_checks` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`event_id` integer NOT NULL,
	`device_id` text,
	`step` text NOT NULL,
	`result` text NOT NULL,
	`code` text,
	`summary` text NOT NULL,
	`details` text,
	`checked_at` integer NOT NULL,
	`checked_by` text,
	`checked_by_name` text,
	`source` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_hub_checks_step" CHECK("hub_checks"."step" IN ('hub_running', 'dns_record', 'certificate', 'link_hub', 'local_dns', 'data_match', 'phone_via_hub', 'offline_scan')),
	CONSTRAINT "ck_hub_checks_result" CHECK("hub_checks"."result" IN ('pass', 'warn', 'fail', 'skipped')),
	CONSTRAINT "ck_hub_checks_source" CHECK("hub_checks"."source" IN ('vm', 'hub'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_hub_checks_id` ON `hub_checks` (`id`);--> statement-breakpoint
CREATE INDEX `ix_hub_checks_event_step` ON `hub_checks` (`event_id`,`step`,`checked_at`);--> statement-breakpoint
ALTER TABLE `devices` ADD `last_pull_at` integer;