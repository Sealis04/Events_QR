CREATE TABLE `event_staff` (
	`event_id` integer NOT NULL,
	`staff_id` text NOT NULL,
	`assigned` integer NOT NULL,
	PRIMARY KEY(`event_id`, `staff_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `battery_pct` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `outbox_size` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `reported_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `reviewed_by` text;--> statement-breakpoint
-- The staff table is rebuilt below to add its CHECK; the column must exist for the copy to read it.
ALTER TABLE `staff` ADD `pin_reset` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_staff` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pin_hash` text NOT NULL,
	`role` text NOT NULL,
	`pin_reset` text,
	CONSTRAINT "ck_staff_pin_reset" CHECK("__new_staff"."pin_reset" IS NULL OR "__new_staff"."pin_reset" IN ('weak', 'rotate')),
	CONSTRAINT "ck_staff_role" CHECK("__new_staff"."role" IN ('staff', 'supervisor', 'admin'))
);
--> statement-breakpoint
INSERT INTO `__new_staff`("id", "name", "pin_hash", "role", "pin_reset") SELECT "id", "name", "pin_hash", "role", "pin_reset" FROM `staff`;--> statement-breakpoint
DROP TABLE `staff`;--> statement-breakpoint
ALTER TABLE `__new_staff` RENAME TO `staff`;--> statement-breakpoint
PRAGMA foreign_keys=ON;