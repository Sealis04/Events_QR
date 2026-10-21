CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`label` text,
	`gate` text NOT NULL,
	`direction` text DEFAULT 'entry' NOT NULL,
	`token_hash` text NOT NULL,
	`revoked` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_devices_direction" CHECK("devices"."direction" IN ('entry', 'exit', 'both'))
);
--> statement-breakpoint
CREATE TABLE `email_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` blob NOT NULL,
	`to_email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_email_queue_status" CHECK("email_queue"."status" IN ('pending', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `ix_email_queue_due` ON `email_queue` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `enrolment_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`code_hash` text NOT NULL,
	`gate` text NOT NULL,
	`direction` text DEFAULT 'entry' NOT NULL,
	`label` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`device_id` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_enrolment_codes_direction" CHECK("enrolment_codes"."direction" IN ('entry', 'exit', 'both'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_enrolment_codes_hash` ON `enrolment_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`enc_key_ref` text NOT NULL,
	`sign_key_id` integer NOT NULL,
	`gates` text NOT NULL,
	`config` text
);
--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` blob NOT NULL,
	`device_id` text,
	`staff_id` text,
	`gate` text NOT NULL,
	`direction` text NOT NULL,
	`scanned_at` integer NOT NULL,
	`received_at` integer,
	`result` text NOT NULL,
	`offline` integer NOT NULL,
	`conflict` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_scans_direction" CHECK("scans"."direction" IN ('entry', 'exit')),
	CONSTRAINT "ck_scans_result" CHECK("scans"."result" IN ('admitted', 'exited', 'rejected_used', 'rejected_inside', 'rejected_gate', 'rejected_slot', 'rejected_invalid', 'override'))
);
--> statement-breakpoint
CREATE INDEX `ix_scans_ticket` ON `scans` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pin_hash` text NOT NULL,
	`role` text NOT NULL,
	CONSTRAINT "ck_staff_role" CHECK("staff"."role" IN ('staff', 'supervisor', 'admin'))
);
--> statement-breakpoint
CREATE TABLE `ticket_types` (
	`event_id` integer NOT NULL,
	`idx` integer NOT NULL,
	`name` text NOT NULL,
	`capacity` integer,
	`issued` integer DEFAULT 0 NOT NULL,
	`entry_mode` text DEFAULT 'single' NOT NULL,
	`max_admits` integer,
	`gate_mask` integer DEFAULT 0 NOT NULL,
	`slots` text,
	`early_entry_min` integer DEFAULT 15 NOT NULL,
	PRIMARY KEY(`event_id`, `idx`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_ticket_types_capacity" CHECK("ticket_types"."capacity" IS NULL OR "ticket_types"."issued" <= "ticket_types"."capacity"),
	CONSTRAINT "ck_ticket_types_entry_mode" CHECK("ticket_types"."entry_mode" IN ('single', 'unlimited', 'limited')),
	CONSTRAINT "ck_ticket_types_max_admits" CHECK(("ticket_types"."entry_mode" = 'limited' AND "ticket_types"."max_admits" IS NOT NULL AND "ticket_types"."max_admits" BETWEEN 2 AND 63) OR ("ticket_types"."entry_mode" <> 'limited' AND "ticket_types"."max_admits" IS NULL)),
	CONSTRAINT "ck_ticket_types_early_entry" CHECK("ticket_types"."early_entry_min" BETWEEN 15 AND 30),
	CONSTRAINT "ck_ticket_types_idx" CHECK("ticket_types"."idx" BETWEEN 0 AND 255)
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` blob PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`ticket_type` integer NOT NULL,
	`holder_name` text,
	`holder_email` text,
	`note` text,
	`issued_by` text,
	`token_nonce` blob NOT NULL,
	`entry_mode` text NOT NULL,
	`max_admits` integer,
	`gate_mask` integer DEFAULT 0 NOT NULL,
	`slot_start` integer,
	`slot_end` integer,
	`admits_used` integer DEFAULT 0 NOT NULL,
	`inside` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'valid' NOT NULL,
	`issued_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_tickets_entry_mode" CHECK("tickets"."entry_mode" IN ('single', 'unlimited', 'limited')),
	CONSTRAINT "ck_tickets_status" CHECK("tickets"."status" IN ('valid', 'used_up', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `ix_tickets_event_updated` ON `tickets` (`event_id`,`updated_at`,`id`);