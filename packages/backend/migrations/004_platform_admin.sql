-- ============================================================
-- Platform admins: manage GLOBAL guides (tenant_id NULL, is_global TRUE).
--
-- Tenants can read global guides but never write them (002). Platform admins
-- get a separate, additive set of permissive policies, keyed on a second
-- session flag that the backend sets ONLY for requests whose verified token
-- carries the platform_admin role (db.ts withTenant(..., { platformAdmin })).
-- The flag only ever widens access to GLOBAL rows — a platform admin still
-- cannot read or write another tenant's own guides.
-- ============================================================

CREATE FUNCTION app_is_platform_admin() RETURNS BOOLEAN
    LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(NULLIF(current_setting('app.is_platform_admin', true), ''), 'false') = 'true' $$;

-- guide: write global rows.
CREATE POLICY guide_global_insert ON guide FOR INSERT
    WITH CHECK (is_global = TRUE AND tenant_id IS NULL AND app_is_platform_admin());
CREATE POLICY guide_global_update ON guide FOR UPDATE
    USING (is_global = TRUE AND app_is_platform_admin())
    WITH CHECK (is_global = TRUE AND tenant_id IS NULL AND app_is_platform_admin());
CREATE POLICY guide_global_delete ON guide FOR DELETE
    USING (is_global = TRUE AND app_is_platform_admin());

-- guide_version: write versions of global guides. Same immutability rule as
-- 003 — only drafts (published_at IS NULL) may be updated or deleted.
CREATE POLICY guide_version_global_insert ON guide_version FOR INSERT
    WITH CHECK (app_is_platform_admin() AND EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.is_global = TRUE
    ));
CREATE POLICY guide_version_global_update ON guide_version FOR UPDATE
    USING (published_at IS NULL AND app_is_platform_admin() AND EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.is_global = TRUE
    ))
    WITH CHECK (app_is_platform_admin() AND EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.is_global = TRUE
    ));
CREATE POLICY guide_version_global_delete ON guide_version FOR DELETE
    USING (published_at IS NULL AND app_is_platform_admin() AND EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.is_global = TRUE
    ));

-- guide_event: platform admins may READ events for global guides across all
-- tenants (the analytics route only ever returns aggregate counts). Events
-- for tenants' own guides stay invisible to them.
CREATE POLICY guide_event_global_select ON guide_event FOR SELECT
    USING (app_is_platform_admin() AND EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_event.guide_id AND g.is_global = TRUE
    ));
