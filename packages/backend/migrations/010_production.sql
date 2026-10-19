-- ============================================================
-- 010 — Running more than one backend, and running for a long time.
--
-- 1. agent_rate_limit: the agent API's per-key/per-client budget, counted in
--    Postgres so every replica sees the same numbers (RATE_LIMIT_STORE=
--    postgres; the in-process limiter stays for development). Unscoped,
--    like system_config: no RLS, nothing in it belongs to a customer.
--
-- 2. Event retention: guide_event grows forever otherwise. A job
--    (src/retention.ts; EVENT_RETENTION_DAYS) deletes old rows under the
--    app.retention session variable — the only path that may delete events.
-- ============================================================

CREATE TABLE agent_rate_limit (
    bucket       TEXT        NOT NULL,   -- "<public key>|<client ip>"
    window_start TIMESTAMPTZ NOT NULL,   -- fixed window, aligned to the window size
    count        INTEGER     NOT NULL,
    PRIMARY KEY (bucket, window_start)
);

CREATE FUNCTION app_retention() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT app_setting_text('app.retention') = 'true'
$$;

-- The job selects the batch it deletes, so it needs both.
CREATE POLICY guide_event_retention_select ON guide_event FOR SELECT USING (app_retention());
CREATE POLICY guide_event_retention_delete ON guide_event FOR DELETE USING (app_retention());

-- Retention and 30-day usage counts both scan by time.
CREATE INDEX IF NOT EXISTS idx_guide_event_occurred_at ON guide_event (occurred_at);
