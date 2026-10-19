-- ============================================================
-- 014 — "Forget this visitor": data-subject requests for end users.
--
-- A customer's app admin can export and delete everything the Service holds
-- about one visitor of one app (guide_event rows and user_guide_state rows
-- keyed by visitor_id) from the Studio, instead of asking the operator to do
-- it in the database. Scope: app_admin_app_ids() — app admins and org
-- owners/admins, the same people who may delete the whole app.
-- guide_event already has a Studio SELECT policy; user_guide_state was
-- agent-only until now.
-- ============================================================

CREATE POLICY guide_event_app_admin_delete ON guide_event FOR DELETE
    USING (app_id = ANY(app_admin_app_ids()));

CREATE POLICY user_guide_state_app_admin_select ON user_guide_state FOR SELECT
    USING (app_id = ANY(app_admin_app_ids()));
CREATE POLICY user_guide_state_app_admin_delete ON user_guide_state FOR DELETE
    USING (app_id = ANY(app_admin_app_ids()));
