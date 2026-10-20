-- ============================================================
-- 017 — The editor / manager split, enforced in the database too.
--
-- Since 016 every editor is "app_admin" on every site of their org, so the
-- policies written for app admins (delete the app, forget a visitor) let an
-- editor do what the API reserves for managers. A new session variable,
-- app.manager_app_ids (the sites of the orgs where the user is a manager or
-- owner), carries the distinction down to the policies:
--   - deleting an application: application_delete (005, admin_org_ids)
--     already covers managers and owners; the per-app grant from 013 is
--     dropped.
--   - forgetting a visitor (014): manager_app_ids instead of admin_app_ids.
-- Rotating the public key or the signing secret is an UPDATE of application,
-- which editors also need for settings, and RLS can't tell columns apart —
-- a trigger refuses a change to those two columns from anyone but a manager.
-- The encrypt-secrets script runs under withMaintenanceSession (platform
-- admin scope) and is let through.
-- ============================================================

CREATE FUNCTION app_manager_app_ids() RETURNS UUID[] LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.manager_app_ids') $$;

DROP POLICY application_app_admin_delete ON application;

DROP POLICY guide_event_app_admin_delete ON guide_event;
CREATE POLICY guide_event_manager_delete ON guide_event FOR DELETE
    USING (app_id = ANY(app_manager_app_ids()));

DROP POLICY user_guide_state_app_admin_select ON user_guide_state;
DROP POLICY user_guide_state_app_admin_delete ON user_guide_state;
CREATE POLICY user_guide_state_manager_select ON user_guide_state FOR SELECT
    USING (app_id = ANY(app_manager_app_ids()));
CREATE POLICY user_guide_state_manager_delete ON user_guide_state FOR DELETE
    USING (app_id = ANY(app_manager_app_ids()));

CREATE FUNCTION application_guard_keys() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- app_platform_admin() is NULL (not false) in a session that never set it,
    -- so test it with IS NOT TRUE: NULL must mean "refuse", never "allow".
    IF (NEW.public_key IS DISTINCT FROM OLD.public_key
        OR NEW.signing_secret IS DISTINCT FROM OLD.signing_secret)
       AND NEW.id <> ALL(app_manager_app_ids())
       AND app_platform_admin() IS NOT TRUE THEN
        RAISE EXCEPTION 'only a manager may rotate an application''s key or signing secret'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER application_guard_keys
    BEFORE UPDATE OF public_key, signing_secret ON application
    FOR EACH ROW EXECUTE FUNCTION application_guard_keys();
