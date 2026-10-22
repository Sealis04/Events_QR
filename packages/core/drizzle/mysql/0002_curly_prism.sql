ALTER TABLE `devices` ADD `kind` varchar(8) DEFAULT 'scanner' NOT NULL;--> statement-breakpoint
ALTER TABLE `enrolment_codes` ADD `kind` varchar(8) DEFAULT 'scanner' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD CONSTRAINT `ck_devices_kind` CHECK (`devices`.`kind` IN ('scanner', 'hub'));--> statement-breakpoint
ALTER TABLE `enrolment_codes` ADD CONSTRAINT `ck_enrolment_codes_kind` CHECK (`enrolment_codes`.`kind` IN ('scanner', 'hub'));