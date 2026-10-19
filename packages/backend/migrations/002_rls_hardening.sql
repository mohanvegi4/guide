-- ============================================================
-- RLS hardening — fixes gaps in 001_init.sql's tenant isolation.
-- 001 is never edited after the fact; every correction lives here.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Null-safe tenant lookup.
-- current_setting(..., true) returns '' (not NULL) once a transaction-local
-- set_config has been used on a pooled connection, and ''::uuid raises an
-- error. NULLIF turns "no tenant set" into NULL, which simply matches no rows
-- (fail closed) instead of erroring.
-- ------------------------------------------------------------
CREATE FUNCTION app_current_tenant_id() RETURNS UUID
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::UUID $$;

-- ------------------------------------------------------------
-- 2. FORCE RLS so it also applies to the table owner.
-- The app role owns these tables (it runs the migrations), and Postgres
-- exempts table owners from RLS unless FORCE is set — without this, the
-- DB-level half of tenant isolation was silently a no-op.
-- (Superusers / BYPASSRLS roles are exempt even with FORCE; db.ts refuses to
-- boot if the app connects as one.)
-- ------------------------------------------------------------
ALTER TABLE guide            FORCE ROW LEVEL SECURITY;
ALTER TABLE guide_event      FORCE ROW LEVEL SECURITY;
ALTER TABLE user_guide_state FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 3. guide: split read vs. write policies.
-- The original single policy's USING clause included `is_global = TRUE`,
-- and for an ALL policy USING also governs UPDATE/DELETE — so any tenant
-- could flag, publish or delete a global guide. Tenants may READ global
-- guides but only WRITE their own. Global guides are managed out-of-band
-- (super-admin tooling is out of scope for v1).
-- ------------------------------------------------------------
DROP POLICY guide_tenant_isolation ON guide;

CREATE POLICY guide_select ON guide FOR SELECT
    USING (is_global = TRUE OR tenant_id = app_current_tenant_id());
CREATE POLICY guide_insert ON guide FOR INSERT
    WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY guide_update ON guide FOR UPDATE
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY guide_delete ON guide FOR DELETE
    USING (tenant_id = app_current_tenant_id());

-- ------------------------------------------------------------
-- 4. guide_version had no RLS at all — isolation relied entirely on every
-- route remembering to check the parent guide first. Policies here defer to
-- the parent guide's visibility (the EXISTS subquery is itself filtered by
-- guide's RLS), so a version is readable iff its guide is, and writable iff
-- its guide is owned by the current tenant.
-- ------------------------------------------------------------
ALTER TABLE guide_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_version FORCE ROW LEVEL SECURITY;

CREATE POLICY guide_version_select ON guide_version FOR SELECT
    USING (EXISTS (SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id));
CREATE POLICY guide_version_insert ON guide_version FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.tenant_id = app_current_tenant_id()
    ));
CREATE POLICY guide_version_update ON guide_version FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.tenant_id = app_current_tenant_id()
    ));
CREATE POLICY guide_version_delete ON guide_version FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.tenant_id = app_current_tenant_id()
    ));

-- ------------------------------------------------------------
-- 5. Re-create the remaining policies on the null-safe helper, with an
-- explicit WITH CHECK so inserts can't write rows for another tenant.
-- ------------------------------------------------------------
DROP POLICY guide_event_tenant_isolation ON guide_event;
CREATE POLICY guide_event_tenant_isolation ON guide_event
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

DROP POLICY user_guide_state_tenant_isolation ON user_guide_state;
CREATE POLICY user_guide_state_tenant_isolation ON user_guide_state
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

-- tenant_config holds the per-tenant kill switch. Tenants only ever read
-- their own row; writes happen out-of-band by ops.
ALTER TABLE tenant_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_config_select ON tenant_config FOR SELECT
    USING (tenant_id = app_current_tenant_id());

-- ------------------------------------------------------------
-- 6. Views execute with the view OWNER's privileges by default, which
-- bypasses the caller's RLS. active_guide therefore returned every tenant's
-- guides to anyone who queried it. security_invoker (Postgres 15+) makes the
-- view respect the querying session's RLS.
-- ------------------------------------------------------------
ALTER VIEW active_guide SET (security_invoker = true);

-- ------------------------------------------------------------
-- 7. guide_event.step_id referenced the normalized `step` table, which the
-- application never populates (steps live as JSONB in guide_version.steps).
-- Publish now assigns each step a UUID, so any step-level event would have
-- violated this FK. step_id is an opaque id into the JSONB array.
-- ------------------------------------------------------------
ALTER TABLE guide_event DROP CONSTRAINT guide_event_step_id_fkey;
