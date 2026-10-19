-- ============================================================
-- 013 — Data lifecycle: a customer can take their data out and delete it.
--
--   GET    /v1/orgs/:orgId/export       owner: everything the org authored, as JSON
--   DELETE /v1/orgs/:orgId              owner: the organization and all its data
--   DELETE /v1/platform/orgs/:orgId     platform admin handling a deletion request
--   DELETE /v1/apps/:appId              app admin: one application and all its data
--
-- Nothing here changes what anyone can READ. It adds the DELETE policies
-- that were missing: until now no session could delete an organization at
-- all, and an application only by an org admin.
--
-- Child rows (apps, guides, versions, pages, events, visitor state, agent
-- errors, members, invitations, the support access log) all reference their
-- parent with ON DELETE CASCADE (001, 005, 007, 009, 011). Referential
-- actions run as the table owner and bypass Row-Level Security, so one
-- DELETE on the organization removes everything that belongs to it in the
-- same transaction — without widening who may delete events or versions
-- (published versions stay immutable for every ordinary session).
-- studio_user rows are never deleted: a person may belong to other orgs.
-- ============================================================

-- Only OWNERS may delete an organization (the Studio API checks the role
-- too). Admin and owner share app.admin_org_ids, so owners get a session
-- variable of their own; db.ts sets it next to the others.
CREATE FUNCTION app_owner_org_ids() RETURNS UUID[] LANGUAGE sql STABLE AS $$
    SELECT app_setting_uuids('app.owner_org_ids')
$$;

CREATE POLICY organization_owner_delete ON organization FOR DELETE
    USING (id = ANY(app_owner_org_ids()));

-- Platform admins delete an organization on a customer's written request
-- (GDPR, contract end). Still never its content: the cascade does the work.
CREATE POLICY organization_platform_delete ON organization FOR DELETE
    USING (app_platform_admin());

-- An app admin may delete their app (application_delete from 005 covers org
-- admins; this is the per-app grant, the same scope as application_update).
CREATE POLICY application_app_admin_delete ON application FOR DELETE
    USING (id = ANY(app_admin_app_ids()));
