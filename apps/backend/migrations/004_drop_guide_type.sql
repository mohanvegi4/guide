-- ============================================================
-- 004 — Guides and steps no longer have a type.
--
-- The type (tooltip, modal, banner, tour, checklist, survey, beacon) never
-- changed how a guide looks: the agent shows every step as the same card,
-- next to its anchor or centered without one. Only 'tour' was read, to show
-- walkthroughs before single tips, and the agent already does that for any
-- guide with more than one step. So the column and its enum go.
--
-- Steps saved before this keep a "type" key inside guide_version.steps
-- (published versions can't be rewritten); nothing reads it.
-- ============================================================

-- The view selects g.type, so it is rebuilt without it (CREATE OR REPLACE
-- can't drop a column). Same definition as 001 otherwise.
DROP VIEW active_guide;
CREATE VIEW active_guide WITH (security_invoker = true) AS
SELECT g.id, g.app_id, g.name,
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

ALTER TABLE guide DROP COLUMN type;
DROP TYPE guide_type;
