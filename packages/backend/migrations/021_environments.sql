-- ============================================================
-- 021 — Environments: release stages per app, and analytics per environment.
--
-- An application now has ordered environments (e.g. Dev → Test → Accept →
-- Prod). Each owns its websites: the agent tells which environment a request
-- belongs to from the page's Origin, which CORS already checks against the
-- app's websites. application.allowed_origins stays, as the union of all the
-- environments' websites the API keeps in sync, because the CORS check reads it.
--
-- A guide has one live version per environment (guide_release). Publishing
-- releases a new version to the first stage; it is then promoted stage by
-- stage. Every release change is logged (guide_release_event), which is what
-- "revert" walks back. The last stage (highest position) is production:
-- guide.current_version_id mirrors its release, so everything that meant
-- "live" before (page usage, the guide list, the export) still means live
-- in production.
--
-- Show-once state and analytics events are kept per environment, so a tester
-- in Accept neither uses up a guide for production nor shows up in its
-- numbers, and each environment can switch analytics recording off.
--
-- Every existing app gets one environment, "Production", holding its current
-- websites; its live versions become that environment's releases.
-- ============================================================

CREATE TABLE app_environment (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id            UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    -- Promotion order; the highest is production. Deferred so a reorder can
    -- swap positions inside one transaction.
    position          INTEGER NOT NULL CHECK (position >= 1),
    origins           TEXT[] NOT NULL DEFAULT '{}',
    analytics_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_app_environment_position UNIQUE (app_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX uq_app_environment_name ON app_environment (app_id, lower(name));
CREATE INDEX idx_app_environment_origins ON app_environment USING gin (origins);

CREATE TABLE guide_release (
    guide_id       UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
    environment_id UUID NOT NULL REFERENCES app_environment(id) ON DELETE CASCADE,
    app_id         UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    version_id     UUID NOT NULL REFERENCES guide_version(id) ON DELETE CASCADE,
    released_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_by    UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    PRIMARY KEY (guide_id, environment_id)
);
CREATE INDEX idx_guide_release_environment ON guide_release (environment_id);

-- One row per change of what an environment runs: the state it set (a
-- version, or NULL for withdrawn). Reverting marks the latest row reverted
-- and restores the one below it, so repeated reverts walk back step by step.
CREATE TABLE guide_release_event (
    id             BIGSERIAL PRIMARY KEY,
    guide_id       UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
    environment_id UUID NOT NULL REFERENCES app_environment(id) ON DELETE CASCADE,
    app_id         UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    version_id     UUID REFERENCES guide_version(id) ON DELETE CASCADE,
    action         TEXT NOT NULL CHECK (action IN ('release', 'withdraw')),
    actor          UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    reverted_at    TIMESTAMPTZ,
    reverted_by    UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    CHECK ((action = 'release') = (version_id IS NOT NULL))
);
CREATE INDEX idx_guide_release_event_lookup ON guide_release_event (guide_id, environment_id, id DESC);

ALTER TABLE guide_event ADD COLUMN environment_id UUID REFERENCES app_environment(id) ON DELETE SET NULL;
CREATE INDEX idx_event_app_environment ON guide_event (app_id, environment_id, occurred_at DESC);

-- ------------------------------------------------------------
-- Backfill. The owner is subject to forced RLS like everyone else, and a
-- migration has no session, so lift it for the copy and restore it after.
-- ------------------------------------------------------------
ALTER TABLE application NO FORCE ROW LEVEL SECURITY;
ALTER TABLE guide NO FORCE ROW LEVEL SECURITY;
ALTER TABLE guide_event NO FORCE ROW LEVEL SECURITY;
ALTER TABLE user_guide_state NO FORCE ROW LEVEL SECURITY;

INSERT INTO app_environment (app_id, name, position, origins)
SELECT id, 'Production', 1, allowed_origins FROM application;

INSERT INTO guide_release (guide_id, environment_id, app_id, version_id, released_at)
SELECT g.id, e.id, g.app_id, g.current_version_id, g.updated_at
FROM guide g JOIN app_environment e ON e.app_id = g.app_id
WHERE g.current_version_id IS NOT NULL;

INSERT INTO guide_release_event (guide_id, environment_id, app_id, version_id, action, occurred_at)
SELECT guide_id, environment_id, app_id, version_id, 'release', released_at FROM guide_release;

UPDATE guide_event ev SET environment_id = e.id FROM app_environment e WHERE e.app_id = ev.app_id;

ALTER TABLE user_guide_state ADD COLUMN environment_id UUID REFERENCES app_environment(id) ON DELETE CASCADE;
UPDATE user_guide_state s SET environment_id = e.id FROM app_environment e WHERE e.app_id = s.app_id;
ALTER TABLE user_guide_state ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE user_guide_state DROP CONSTRAINT user_guide_state_pkey;
ALTER TABLE user_guide_state ADD PRIMARY KEY (app_id, environment_id, visitor_id, guide_id);

ALTER TABLE application FORCE ROW LEVEL SECURITY;
ALTER TABLE guide FORCE ROW LEVEL SECURITY;
ALTER TABLE guide_event FORCE ROW LEVEL SECURITY;
ALTER TABLE user_guide_state FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- Row-level security, in the same shape as guide and app_page.
-- ------------------------------------------------------------
ALTER TABLE app_environment ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_environment FORCE ROW LEVEL SECURITY;
ALTER TABLE guide_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_release FORCE ROW LEVEL SECURITY;
ALTER TABLE guide_release_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_release_event FORCE ROW LEVEL SECURITY;

-- Environments own websites (CORS), so writes follow application_update
-- (editor and up), plus managers creating a new app in their organization.
CREATE POLICY app_environment_select ON app_environment FOR SELECT
    USING (app_id = ANY(app_app_ids()) OR app_id = app_current_app_id() OR app_platform_admin() IS TRUE);
CREATE POLICY app_environment_insert ON app_environment FOR INSERT
    WITH CHECK (
        app_id = ANY(app_admin_app_ids())
        OR EXISTS (SELECT 1 FROM application a WHERE a.id = app_id AND a.org_id = ANY(app_admin_org_ids()))
    );
CREATE POLICY app_environment_update ON app_environment FOR UPDATE
    USING (app_id = ANY(app_admin_app_ids())) WITH CHECK (app_id = ANY(app_admin_app_ids()));
CREATE POLICY app_environment_delete ON app_environment FOR DELETE
    USING (app_id = ANY(app_admin_app_ids()));

-- Releases are content, like guides: any member's session passes, roles are
-- checked by the routes. The agent reads its own app's releases.
CREATE POLICY guide_release_studio ON guide_release
    USING (app_id = ANY(app_app_ids())) WITH CHECK (app_id = ANY(app_app_ids()));
CREATE POLICY guide_release_agent_select ON guide_release FOR SELECT
    USING (app_id = app_current_app_id());

-- The release log: read and appended by the Studio; only the revert marks
-- change afterwards, never the recorded state.
CREATE POLICY guide_release_event_select ON guide_release_event FOR SELECT
    USING (app_id = ANY(app_app_ids()));
CREATE POLICY guide_release_event_insert ON guide_release_event FOR INSERT
    WITH CHECK (app_id = ANY(app_app_ids()));
CREATE POLICY guide_release_event_update ON guide_release_event FOR UPDATE
    USING (app_id = ANY(app_app_ids())) WITH CHECK (app_id = ANY(app_app_ids()));

-- ------------------------------------------------------------
-- active_guide: one row per guide per environment it is released to.
-- Same columns as 020 plus environment_id last. A release points at a
-- published version; published_at is checked again as a backstop.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW active_guide WITH (security_invoker = true) AS
SELECT g.id, g.app_id, g.name, g.type,
       gv.id AS version_id, gv.version_number, gv.steps,
       CASE WHEN p.id IS NOT NULL
            THEN jsonb_build_object('type', p.match_type::text, 'value', p.match_value)
            ELSE gv.route_match END AS route_match,
       gv.account_ids,
       gv.start_at, gv.end_at,
       gv.help,
       p.id AS page_id,
       COALESCE(p.start_path, CASE WHEN p.match_type = 'exact' THEN p.match_value END) AS page_start_path,
       gv.activation,
       gv.visitor_tags,
       r.environment_id
FROM guide_release r
JOIN guide g ON g.id = r.guide_id
JOIN guide_version gv ON gv.id = r.version_id AND gv.published_at IS NOT NULL
LEFT JOIN app_page p ON p.id = gv.page_id
WHERE g.enabled = TRUE
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at IS NULL OR gv.end_at >= now());
