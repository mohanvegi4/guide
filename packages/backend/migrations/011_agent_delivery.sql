-- ============================================================
-- 011 — Agent-side error reporting.
--
-- The agent fails silent towards the host page, which also means nobody
-- hears when it breaks. It now reports a sampled, capped trickle of the
-- exceptions it swallows (POST /v1/agent/:key/errors); this table holds
-- them per app so the Studio can show "recent agent errors" and the
-- platform page can count them. Free text from a public endpoint: only ever
-- rendered as text, never as HTML.
-- ============================================================

CREATE TABLE agent_error (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id        UUID        NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    message       TEXT        NOT NULL,
    stack         TEXT,
    agent_version TEXT,
    url           TEXT,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Latest 50 for this app", the per-app hourly cap and the 24 h count all
-- scan by app and time; retention scans by time alone.
CREATE INDEX idx_agent_error_app_time ON agent_error (app_id, occurred_at DESC);
CREATE INDEX idx_agent_error_occurred_at ON agent_error (occurred_at);

ALTER TABLE agent_error ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_error FORCE ROW LEVEL SECURITY;

-- The agent writes its own app's errors. It may also read them: the
-- endpoint counts the app's last hour before inserting (the storage cap), in
-- the same agent session. Nothing in a row is a secret from the page that
-- sent it.
CREATE POLICY agent_error_agent_insert ON agent_error FOR INSERT WITH CHECK (app_id = app_current_app_id());
CREATE POLICY agent_error_agent_select ON agent_error FOR SELECT USING (app_id = app_current_app_id());

-- Studio members of the app see them (role enforced in the API: viewer+);
-- platform admins see counts across apps (never guide content, and these
-- rows contain none).
CREATE POLICY agent_error_studio_select   ON agent_error FOR SELECT USING (app_id = ANY(app_app_ids()));
CREATE POLICY agent_error_platform_select ON agent_error FOR SELECT USING (app_platform_admin());

-- Retention (src/retention.ts) deletes old rows under app.retention, the
-- same way as guide_event (migration 010). The job selects its batch first.
CREATE POLICY agent_error_retention_select ON agent_error FOR SELECT USING (app_retention());
CREATE POLICY agent_error_retention_delete ON agent_error FOR DELETE USING (app_retention());
