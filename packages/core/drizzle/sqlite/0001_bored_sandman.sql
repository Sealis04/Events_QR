CREATE TABLE `hub_device_outbox` (
	`device_id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer NOT NULL,
	`acked_at` integer
);
--> statement-breakpoint
CREATE TABLE `hub_scan_outbox` (
	`scan_id` text PRIMARY KEY NOT NULL,
	`acked_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_hub_scan_outbox_pending` ON `hub_scan_outbox` (`acked_at`);--> statement-breakpoint
CREATE TABLE `hub_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
-- Hand-written: drizzle-kit rebuilds the tables for a new column and selects it from the old one.
ALTER TABLE `devices` ADD `kind` text DEFAULT 'scanner' NOT NULL CONSTRAINT "ck_devices_kind" CHECK(`kind` IN ('scanner', 'hub'));--> statement-breakpoint
ALTER TABLE `enrolment_codes` ADD `kind` text DEFAULT 'scanner' NOT NULL CONSTRAINT "ck_enrolment_codes_kind" CHECK(`kind` IN ('scanner', 'hub'));
