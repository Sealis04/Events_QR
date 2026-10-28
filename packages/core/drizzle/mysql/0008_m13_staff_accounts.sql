CREATE TABLE `audit_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`at` bigint NOT NULL,
	`actor_staff_id` char(36),
	`action` varchar(32) NOT NULL,
	`target_kind` varchar(16) NOT NULL,
	`target_id` varchar(64) NOT NULL,
	`detail` json,
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `staff` DROP CONSTRAINT `ck_staff_pin_reset`;--> statement-breakpoint
ALTER TABLE `staff` ADD `deactivated_at` bigint;--> statement-breakpoint
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_actor_staff_id_staff_id_fk` FOREIGN KEY (`actor_staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_audit_log_target` ON `audit_log` (`target_kind`,`target_id`,`at`);--> statement-breakpoint
CREATE INDEX `ix_audit_log_at` ON `audit_log` (`at`);--> statement-breakpoint
ALTER TABLE `staff` ADD CONSTRAINT `ck_staff_pin_reset` CHECK (`staff`.`pin_reset` IS NULL OR `staff`.`pin_reset` IN ('weak', 'rotate', 'admin'));