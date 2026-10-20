-- ============================================================
-- 016 — Organization-wide roles, part 2 of 2: convert and enforce.
--
--   owner    everything, including ownership, support access, export/delete
--   manager  the old "admin": runs the organization, creates sites, manages
--            members; no owner-only actions
--   editor   the old per-site grants, now across every site: guides, pages,
--            publishing, site settings; cannot create, delete or rotate sites
--   viewer   read-only everywhere
--
-- Per-site grants (app_member) are converted: anyone with an editing grant on
-- any site becomes an editor of the organization, the rest become viewers.
-- The app_member table stays (its policies are harmless) but is empty and
-- no longer read. Pending invitations are converted the same way.
-- ============================================================

-- Migrations run as the app role, which FORCE ROW LEVEL SECURITY also binds:
-- with no session variables set, these tables look empty. Lift FORCE for the
-- conversion (the owner then bypasses RLS, as any other owner would) and put
-- it back before the constraints are added.
ALTER TABLE org_member  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app_member  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE application NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invitation  NO FORCE ROW LEVEL SECURITY;

UPDATE org_member SET role = 'manager' WHERE role = 'admin';
UPDATE org_member m
SET role = CASE
    WHEN EXISTS (SELECT 1 FROM app_member am JOIN application a ON a.id = am.app_id
                  WHERE am.user_id = m.user_id AND a.org_id = m.org_id
                    AND am.role IN ('editor', 'publisher', 'app_admin'))
    THEN 'editor'::org_role ELSE 'viewer'::org_role END
WHERE role = 'member';

UPDATE invitation SET org_role = 'manager' WHERE org_role = 'admin';
UPDATE invitation
SET org_role = CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_each_text(app_roles) r WHERE r.value IN ('editor', 'publisher', 'app_admin'))
    THEN 'editor'::org_role ELSE 'viewer'::org_role END
WHERE org_role = 'member';
ALTER TABLE invitation ALTER COLUMN org_role SET DEFAULT 'viewer';
ALTER TABLE invitation ALTER COLUMN app_roles SET DEFAULT '{}'::jsonb;

DELETE FROM app_member;

ALTER TABLE org_member  FORCE ROW LEVEL SECURITY;
ALTER TABLE app_member  FORCE ROW LEVEL SECURITY;
ALTER TABLE application FORCE ROW LEVEL SECURITY;
ALTER TABLE invitation  FORCE ROW LEVEL SECURITY;

ALTER TABLE org_member ADD CONSTRAINT chk_org_member_role
    CHECK (role IN ('owner', 'manager', 'editor', 'viewer'));
ALTER TABLE invitation ADD CONSTRAINT chk_invitation_role
    CHECK (org_role IN ('manager', 'editor', 'viewer'));


-- Every member of an organization now sees all of its sites (roles are
-- org-wide), so the Studio session no longer needs a per-site id list to
-- discover them. The agent and invitation clauses are unchanged.
DROP POLICY application_select ON application;
CREATE POLICY application_select ON application FOR SELECT USING (
    org_id = ANY(app_org_ids())
    OR id = ANY(app_app_ids())
    OR public_key = app_public_key()
    OR id = app_current_app_id()
    OR org_id IN (SELECT i.org_id FROM invitation i WHERE i.token_hash = app_invite_token_hash())
);
