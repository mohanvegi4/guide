-- Runs once, on first container start, as the bootstrap superuser.
--
-- The app role is deliberately NOSUPERUSER + NOBYPASSRLS: Postgres superusers
-- and BYPASSRLS roles skip Row-Level Security entirely (even with FORCE ROW
-- LEVEL SECURITY), which would silently disable the DB-level half of org/app
-- isolation. The backend also refuses to boot if it detects either attribute
-- (see packages/backend/src/db.ts assertRlsEnforceable()).
CREATE ROLE guide_engine LOGIN PASSWORD 'guide_engine' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

CREATE DATABASE guide_engine OWNER guide_engine;
CREATE DATABASE guide_engine_test OWNER guide_engine;
