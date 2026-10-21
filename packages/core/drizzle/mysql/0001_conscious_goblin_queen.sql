CREATE TABLE `idempotency_keys` (
	`event_id` int NOT NULL,
	`key` varchar(128) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`ticket_ids` json NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `idempotency_keys_event_id_key_pk` PRIMARY KEY(`event_id`,`key`)
);
--> statement-breakpoint
ALTER TABLE `idempotency_keys` ADD CONSTRAINT `idempotency_keys_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;