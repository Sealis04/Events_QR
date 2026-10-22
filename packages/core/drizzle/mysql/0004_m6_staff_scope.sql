CREATE TABLE `event_staff` (
	`event_id` int NOT NULL,
	`staff_id` char(36) NOT NULL,
	`assigned` boolean NOT NULL,
	CONSTRAINT `event_staff_event_id_staff_id_pk` PRIMARY KEY(`event_id`,`staff_id`)
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `battery_pct` smallint;--> statement-breakpoint
ALTER TABLE `devices` ADD `outbox_size` int;--> statement-breakpoint
ALTER TABLE `devices` ADD `reported_at` bigint;--> statement-breakpoint
ALTER TABLE `scans` ADD `reviewed_at` bigint;--> statement-breakpoint
ALTER TABLE `scans` ADD `reviewed_by` char(36);--> statement-breakpoint
ALTER TABLE `staff` ADD `pin_reset` varchar(8);--> statement-breakpoint
ALTER TABLE `event_staff` ADD CONSTRAINT `event_staff_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `event_staff` ADD CONSTRAINT `event_staff_staff_id_staff_id_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff` ADD CONSTRAINT `ck_staff_pin_reset` CHECK (`staff`.`pin_reset` IS NULL OR `staff`.`pin_reset` IN ('weak', 'rotate'));