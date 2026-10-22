-- Sealis04/Events_QR#9: tickets cancelled before cancelled_at existed (M5) get their last update time
-- as the cancellation time, so offline admits after it are flagged. Idempotent: only NULLs change.
UPDATE `tickets` SET `cancelled_at` = `updated_at` WHERE `status` = 'cancelled' AND `cancelled_at` IS NULL;--> statement-breakpoint
-- Longer supervisor/admin PINs (M6): every existing supervisor and admin changes their PIN at next
-- login unless the one they type already meets the rule. Until then their hash is not sent to phones.
UPDATE `staff` SET `pin_reset` = 'weak' WHERE `role` IN ('supervisor', 'admin') AND `pin_reset` IS NULL;
