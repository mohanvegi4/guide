-- ============================================================
-- 015 — Organization-wide roles, part 1 of 2: the new enum values.
--
-- Roles become one per person per organization, applying to every one of
-- its sites: owner > manager > editor > viewer. Postgres can add enum values
-- inside a transaction but refuses to USE them in the same transaction, and
-- the migration runner wraps each file in one — so adding the values and
-- converting the data are two files. 'admin' and 'member' stay in the type
-- (enum values can't be dropped); 016 forbids them with a CHECK.
-- ============================================================

ALTER TYPE org_role ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE org_role ADD VALUE IF NOT EXISTS 'editor';
ALTER TYPE org_role ADD VALUE IF NOT EXISTS 'viewer';
