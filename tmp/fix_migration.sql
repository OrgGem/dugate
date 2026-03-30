-- Remove any failed record for our migration so prisma can retry
DELETE FROM _prisma_migrations WHERE migration_name = '20260327000000_add_comparison';
