-- ============================================================
-- 002 — Drop what the code no longer uses.
--
--   app_member, app_role      per-app roles, retired for the organization-wide
--                             role; the table has been empty since
--   invitation.app_roles      the per-app grants an invitation used to carry
--   step                      an early normalized steps table, never used
--                             (steps live in guide_version.steps)
--   org_role 'admin','member' retired roles (now manager / editor / viewer);
--                             CHECK constraints already kept them out
--   user_guide_status         never written
--     'snoozed'
--
-- Postgres can't remove a value from an enum, so the two enums are rebuilt:
-- rename the old type, create the new one, move the columns over, drop the
-- old. Anything that embeds the old type must be dropped first and
-- recreated against the new one: the policy that compares roles, the CHECK
-- constraints that list roles, and the column default.
-- ============================================================

-- ------------------------------------------------------------
-- Per-app roles and the unused steps table.
-- ------------------------------------------------------------

-- studio_user_select also let app admins see users with a per-app grant;
-- without the table that clause goes.
DROP POLICY studio_user_select ON studio_user;
CREATE POLICY studio_user_select ON studio_user FOR SELECT USING (
    oidc_issuer || '|' || oidc_sub = app_current_identity()
    OR id = app_current_user_id()
    OR id IN (SELECT m.user_id FROM org_member m WHERE m.org_id = ANY(app_org_ids()))
);

DROP TABLE app_member; -- its policies go with it
DROP TYPE app_role;
ALTER TABLE invitation DROP COLUMN app_roles;
DROP TABLE step;

-- ------------------------------------------------------------
-- org_role without 'admin' and 'member'.
-- ------------------------------------------------------------

DROP POLICY org_member_insert ON org_member;
ALTER TABLE org_member DROP CONSTRAINT chk_org_member_role;
ALTER TABLE invitation DROP CONSTRAINT chk_invitation_role;
ALTER TABLE invitation DROP CONSTRAINT chk_invite_not_owner;
ALTER TABLE invitation ALTER COLUMN org_role DROP DEFAULT;

ALTER TYPE org_role RENAME TO org_role_old;
CREATE TYPE org_role AS ENUM ('owner', 'manager', 'editor', 'viewer');
ALTER TABLE org_member ALTER COLUMN role TYPE org_role USING role::text::org_role;
ALTER TABLE invitation ALTER COLUMN org_role TYPE org_role USING org_role::text::org_role;
DROP TYPE org_role_old;

-- The type itself now admits only the four roles, so org_member needs no
-- CHECK. Owners are still never invited: they are promoted from the member list.
ALTER TABLE invitation ALTER COLUMN org_role SET DEFAULT 'viewer';
ALTER TABLE invitation ADD CONSTRAINT chk_invitation_role CHECK (org_role IN ('manager', 'editor', 'viewer'));

-- As in 001: managers add members; the creator becomes owner in the creating
-- transaction; an invitee joins with exactly the invited role while the
-- invitation is open.
CREATE POLICY org_member_insert ON org_member FOR INSERT WITH CHECK (
    org_id = ANY(app_admin_org_ids())
    OR (user_id = app_current_user_id() AND role = 'owner' AND EXISTS (
        SELECT 1 FROM organization o
        WHERE o.id = org_member.org_id AND o.created_by = app_current_user_id() AND o.created_at = now()))
    OR (user_id = app_current_user_id() AND EXISTS (
        SELECT 1 FROM invitation i
        WHERE i.org_id = org_member.org_id AND i.token_hash = app_invite_token_hash()
          AND i.accepted_at IS NULL AND i.expires_at > now() AND i.org_role = org_member.role))
);

-- ------------------------------------------------------------
-- user_guide_status without 'snoozed'.
-- ------------------------------------------------------------

ALTER TYPE user_guide_status RENAME TO user_guide_status_old;
CREATE TYPE user_guide_status AS ENUM ('dismissed', 'completed', 'shown');
ALTER TABLE user_guide_state ALTER COLUMN status TYPE user_guide_status USING status::text::user_guide_status;
DROP TYPE user_guide_status_old;
