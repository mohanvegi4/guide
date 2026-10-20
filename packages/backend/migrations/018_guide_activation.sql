-- ============================================================
-- 018 — How a guide starts: automatically, or only on demand.
--
--   guide_version.activation
--     'auto'    shows when the visitor lands on its page (once per published
--               version, queued one at a time by the agent) — welcome tours,
--               "what's new", new-feature announcements. Today's behaviour.
--     'manual'  never pops up; reachable only from the help center or a
--               shared help link, so it must carry a help listing (the API
--               enforces this; the CHECK here is the backstop).
--
-- It lives on the version, next to `help`: like the content it is authoring
-- intent that takes effect on publish, not a switch like guide.enabled.
-- The agent's /guides call serves only 'auto' versions; /help serves both.
-- ============================================================

ALTER TABLE guide_version
    ADD COLUMN activation TEXT NOT NULL DEFAULT 'auto',
    ADD CONSTRAINT chk_guide_version_activation CHECK (activation IN ('auto', 'manual')),
    ADD CONSTRAINT chk_manual_needs_help CHECK (activation = 'auto' OR help IS NOT NULL);

-- Expose it on the active-guides view (new columns go last; the view's
-- definition is otherwise that of 007).
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
       gv.activation
FROM guide g
JOIN guide_version gv ON gv.id = g.current_version_id
LEFT JOIN app_page p ON p.id = gv.page_id
WHERE g.enabled = TRUE
  AND g.status = 'published'
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at IS NULL OR gv.end_at >= now());
