-- Sealis04/Events_QR#9: see the MariaDB migration of the same name. Idempotent.
UPDATE `tickets` SET `cancelled_at` = `updated_at` WHERE `status` = 'cancelled' AND `cancelled_at` IS NULL;
