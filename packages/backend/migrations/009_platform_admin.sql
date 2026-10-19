-- ============================================================
-- 009 — Guide Engine administration, Pendo-style.
--
-- Two kinds of access above the organization level:
--
-- 1. Platform admins (studio_user.platform_admin) run the service: list
--    organizations and apps with usage, suspend an organization or disable
--    an app for abuse, flip the global kill switch, grant the flag. This
--    never shows a customer's guide CONTENT: the platform policies below
--    cover organizations, apps, members, guide names and event rows (for
--    counts), not guide_version / app_page / user_guide_state.
--
-- 2. Support access: an organization OWNER opens the door for a limited
--    time (organization.support_access_until, at most 90 days). While it is
--    open, a platform admin may read that organization like a viewer, in a
--    READ ONLY transaction (db.ts withSupportSession), and every request is
--    written to support_access_log, which the organization's admins can see.
--    Off by default; nothing here is self-granted.
--
-- The first platform admin is granted with SQL by the database owner
-- (see README); later ones from the Operator page.
-- ============================================================

ALTER TABLE studio_user ADD COLUMN platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE organization
    ADD COLUMN suspended_at              TIMESTAMPTZ,
    ADD COLUMN support_access_until      TIMESTAMPTZ,
    ADD COLUMN support_access_granted_by UUID REFERENCES studio_user(id) ON DELETE SET NULL;

-- Denormalized onto the app so the agent (which only ever reads its own
-- application row) can fail closed without a policy on organization.
ALTER TABLE application ADD COLUMN suspended_at TIMESTAMPTZ;

CREATE TABLE support_access_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    admin_user_id UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    -- Snapshot: the organization's admins can't read the platform admin's
    -- studio_user row (they share no organization), and the log should
    -- still name who it was after they leave.
    admin_name    TEXT,
    admin_email   TEXT,
    method        TEXT NOT NULL,
    path          TEXT NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_support_access_log_org ON support_access_log (org_id, occurred_at DESC);

-- Set only by withPlatformSession / withSupportSession after checking the flag.
CREATE FUNCTION app_platform_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT app_setting_text('app.platform_admin') = 'true'
$$;

-- ------------------------------------------------------------
-- Platform policies (service administration; no customer content)
-- ------------------------------------------------------------
CREATE POLICY studio_user_platform_select ON studio_user FOR SELECT USING (app_platform_admin());
CREATE POLICY studio_user_platform_update ON studio_user FOR UPDATE
    USING (app_platform_admin()) WITH CHECK (app_platform_admin());

CREATE POLICY organization_platform_select ON organization FOR SELECT USING (app_platform_admin());
CREATE POLICY organization_platform_update ON organization FOR UPDATE
    USING (app_platform_admin()) WITH CHECK (app_platform_admin());

CREATE POLICY application_platform_select ON application FOR SELECT USING (app_platform_admin());
CREATE POLICY application_platform_update ON application FOR UPDATE
    USING (app_platform_admin()) WITH CHECK (app_platform_admin());

CREATE POLICY org_member_platform_select ON org_member FOR SELECT USING (app_platform_admin());

-- Names, status and counts only; versions (the content) stay closed.
CREATE POLICY guide_platform_select ON guide FOR SELECT USING (app_platform_admin());

-- guide_version's select policy (005) was "visible iff its guide is", which
-- would now open every version to platform admins. Name the scopes instead:
-- Studio members of the app, or the agent for its own app.
DROP POLICY guide_version_select ON guide_version;
CREATE POLICY guide_version_select ON guide_version FOR SELECT USING (
    EXISTS (SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id
              AND (g.app_id = ANY(app_app_ids()) OR g.app_id = app_current_app_id())));
CREATE POLICY guide_event_platform_select ON guide_event FOR SELECT USING (app_platform_admin());

-- ------------------------------------------------------------
-- Support access log: written by platform admins, read by the
-- organization's admins (and platform admins).
-- ------------------------------------------------------------
ALTER TABLE support_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY support_access_log_select ON support_access_log FOR SELECT
    USING (org_id = ANY(app_admin_org_ids()) OR app_platform_admin());
CREATE POLICY support_access_log_insert ON support_access_log FOR INSERT
    WITH CHECK (app_platform_admin());
