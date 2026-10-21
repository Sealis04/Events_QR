CREATE TABLE `devices` (
	`id` char(36) NOT NULL,
	`event_id` int NOT NULL,
	`label` varchar(255),
	`gate` varchar(255) NOT NULL,
	`direction` varchar(8) NOT NULL DEFAULT 'entry',
	`token_hash` text NOT NULL,
	`revoked` boolean NOT NULL DEFAULT false,
	`last_seen_at` bigint,
	CONSTRAINT `devices_id` PRIMARY KEY(`id`),
	CONSTRAINT `ck_devices_direction` CHECK(`devices`.`direction` IN ('entry', 'exit', 'both'))
);
--> statement-breakpoint
CREATE TABLE `email_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticket_id` binary(16) NOT NULL,
	`to_email` varchar(320) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` tinyint NOT NULL DEFAULT 0,
	`last_error` text,
	`next_attempt_at` bigint NOT NULL,
	`created_at` bigint NOT NULL,
	`sent_at` bigint,
	CONSTRAINT `email_queue_id` PRIMARY KEY(`id`),
	CONSTRAINT `ck_email_queue_status` CHECK(`email_queue`.`status` IN ('pending', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `enrolment_codes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`event_id` int NOT NULL,
	`code_hash` char(64) NOT NULL,
	`gate` varchar(255) NOT NULL,
	`direction` varchar(8) NOT NULL DEFAULT 'entry',
	`label` varchar(255),
	`created_by` char(36),
	`created_at` bigint NOT NULL,
	`expires_at` bigint NOT NULL,
	`used_at` bigint,
	`device_id` char(36),
	CONSTRAINT `enrolment_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `ux_enrolment_codes_hash` UNIQUE(`code_hash`),
	CONSTRAINT `ck_enrolment_codes_direction` CHECK(`enrolment_codes`.`direction` IN ('entry', 'exit', 'both'))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`starts_at` bigint NOT NULL,
	`ends_at` bigint NOT NULL,
	`enc_key_ref` text NOT NULL,
	`sign_key_id` smallint NOT NULL,
	`gates` json NOT NULL,
	`config` json,
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scans` (
	`id` char(36) NOT NULL,
	`ticket_id` binary(16) NOT NULL,
	`device_id` char(36),
	`staff_id` char(36),
	`gate` varchar(255) NOT NULL,
	`direction` varchar(8) NOT NULL,
	`scanned_at` bigint NOT NULL,
	`received_at` bigint,
	`result` varchar(24) NOT NULL,
	`offline` boolean NOT NULL,
	`conflict` boolean NOT NULL DEFAULT false,
	CONSTRAINT `scans_id` PRIMARY KEY(`id`),
	CONSTRAINT `ck_scans_direction` CHECK(`scans`.`direction` IN ('entry', 'exit')),
	CONSTRAINT `ck_scans_result` CHECK(`scans`.`result` IN ('admitted', 'exited', 'rejected_used', 'rejected_inside', 'rejected_gate', 'rejected_slot', 'rejected_invalid', 'override'))
);
--> statement-breakpoint
CREATE TABLE `staff` (
	`id` char(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`pin_hash` text NOT NULL,
	`role` varchar(16) NOT NULL,
	CONSTRAINT `staff_id` PRIMARY KEY(`id`),
	CONSTRAINT `ck_staff_role` CHECK(`staff`.`role` IN ('staff', 'supervisor', 'admin'))
);
--> statement-breakpoint
CREATE TABLE `ticket_types` (
	`event_id` int NOT NULL,
	`idx` smallint NOT NULL,
	`name` varchar(255) NOT NULL,
	`capacity` int,
	`issued` int NOT NULL DEFAULT 0,
	`entry_mode` varchar(16) NOT NULL DEFAULT 'single',
	`max_admits` smallint,
	`gate_mask` smallint unsigned NOT NULL DEFAULT 0,
	`slots` json,
	`early_entry_min` smallint NOT NULL DEFAULT 15,
	CONSTRAINT `ticket_types_event_id_idx_pk` PRIMARY KEY(`event_id`,`idx`),
	CONSTRAINT `ck_ticket_types_capacity` CHECK(`ticket_types`.`capacity` IS NULL OR `ticket_types`.`issued` <= `ticket_types`.`capacity`),
	CONSTRAINT `ck_ticket_types_entry_mode` CHECK(`ticket_types`.`entry_mode` IN ('single', 'unlimited', 'limited')),
	CONSTRAINT `ck_ticket_types_max_admits` CHECK((`ticket_types`.`entry_mode` = 'limited' AND `ticket_types`.`max_admits` IS NOT NULL AND `ticket_types`.`max_admits` BETWEEN 2 AND 63) OR (`ticket_types`.`entry_mode` <> 'limited' AND `ticket_types`.`max_admits` IS NULL)),
	CONSTRAINT `ck_ticket_types_early_entry` CHECK(`ticket_types`.`early_entry_min` BETWEEN 15 AND 30),
	CONSTRAINT `ck_ticket_types_idx` CHECK(`ticket_types`.`idx` BETWEEN 0 AND 255)
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` binary(16) NOT NULL,
	`event_id` int NOT NULL,
	`ticket_type` smallint NOT NULL,
	`holder_name` varchar(255),
	`holder_email` varchar(320),
	`note` text,
	`issued_by` char(36),
	`token_nonce` binary(12) NOT NULL,
	`entry_mode` varchar(16) NOT NULL,
	`max_admits` smallint,
	`gate_mask` smallint unsigned NOT NULL DEFAULT 0,
	`slot_start` bigint,
	`slot_end` bigint,
	`admits_used` smallint NOT NULL DEFAULT 0,
	`inside` boolean NOT NULL DEFAULT false,
	`status` varchar(16) NOT NULL DEFAULT 'valid',
	`issued_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `tickets_id` PRIMARY KEY(`id`),
	CONSTRAINT `ck_tickets_entry_mode` CHECK(`tickets`.`entry_mode` IN ('single', 'unlimited', 'limited')),
	CONSTRAINT `ck_tickets_status` CHECK(`tickets`.`status` IN ('valid', 'used_up', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE `devices` ADD CONSTRAINT `devices_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `email_queue` ADD CONSTRAINT `email_queue_ticket_id_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrolment_codes` ADD CONSTRAINT `enrolment_codes_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrolment_codes` ADD CONSTRAINT `enrolment_codes_created_by_staff_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrolment_codes` ADD CONSTRAINT `enrolment_codes_device_id_devices_id_fk` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scans` ADD CONSTRAINT `scans_ticket_id_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scans` ADD CONSTRAINT `scans_device_id_devices_id_fk` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scans` ADD CONSTRAINT `scans_staff_id_staff_id_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ticket_types` ADD CONSTRAINT `ticket_types_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tickets` ADD CONSTRAINT `tickets_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tickets` ADD CONSTRAINT `tickets_issued_by_staff_id_fk` FOREIGN KEY (`issued_by`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_email_queue_due` ON `email_queue` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `ix_scans_ticket` ON `scans` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `ix_tickets_event_updated` ON `tickets` (`event_id`,`updated_at`,`id`);