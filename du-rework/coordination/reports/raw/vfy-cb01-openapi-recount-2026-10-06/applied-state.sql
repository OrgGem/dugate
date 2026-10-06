BEGIN READ ONLY;
SELECT max(sequence) AS max_sequence, count(*) AS applied_count FROM schema_migrations;
SELECT sequence, filename FROM schema_migrations WHERE sequence >= 34 ORDER BY sequence;
SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
WHERE table_schema='public' AND ((table_name='operations' AND column_name='callback_policy') OR
(table_name='webhook_deliveries' AND column_name IN ('mode','callback_policy')));
COMMIT;
