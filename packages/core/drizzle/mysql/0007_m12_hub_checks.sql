CREATE TABLE `hub_checks` (
	`id` char(36) NOT NULL,
	`event_id` int NOT NULL,
	`device_id` char(36),
	`step` varchar(24) NOT NULL,
	`result` varchar(8) NOT NULL,
	`code` varchar(40),
	`summary` text NOT NULL,
	`details` json,
	`checked_at` bigint NOT NULL,
	`checked_by` char(36),
	`checked_by_name` varchar(255),
	`source` varchar(4) NOT NULL,
	CONSTRAINT `hub_checks_id` PRIMARY KEY(`id`),
	CONSTRAINT `ck_hub_checks_step` CHECK(`hub_checks`.`step` IN ('hub_running', 'dns_record', 'certificate', 'link_hub', 'local_dns', 'data_match', 'phone_via_hub', 'offline_scan')),
	CONSTRAINT `ck_hub_checks_result` CHECK(`hub_checks`.`result` IN ('pass', 'warn', 'fail', 'skipped')),
	CONSTRAINT `ck_hub_checks_source` CHECK(`hub_checks`.`source` IN ('vm', 'hub'))
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `last_pull_at` bigint;--> statement-breakpoint
ALTER TABLE `hub_checks` ADD CONSTRAINT `hub_checks_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_hub_checks_event_step` ON `hub_checks` (`event_id`,`step`,`checked_at`);