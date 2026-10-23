-- ============================================================
-- 020 — Visitor tags: target a guide by what the visitor may do.
--
--   guide_version.visitor_tags
--     NULL     every visitor (today's behaviour)
--     {a,b,…}  only visitors who carry at least one of these tags
--
-- Tags are opaque strings the host application derives from its own
-- permission model (for example "POINT_OF_SALE" or "CUSTOMERS:edit") and
-- passes as visitor.tags — inside the signed identity token when the app
-- requires one, so they can't be forged from the browser. Guide Engine never
-- interprets them; it only tests overlap, the same way account_ids works.
--
-- Like account_ids it lives on the version: audience is authoring intent that
-- takes effect on publish. The agent's /guides and /help apply it; preview
-- links ignore it, as they ignore every other audience rule.
-- ============================================================

ALTER TABLE guide_version
    ADD COLUMN visitor_tags TEXT[],
    -- The API caps the list at 100; the CHECK is the backstop, and keeps an
    -- empty array (which would match nobody) from meaning anything.
    ADD CONSTRAINT chk_guide_version_visitor_tags
        CHECK (visitor_tags IS NULL OR cardinality(visitor_tags) BETWEEN 1 AND 100);

-- Expose it on the active-guides view (new columns go last; the definition is
-- otherwise that of 018).
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
       gv.visitor_tags
FROM guide g
JOIN guide_version gv ON gv.id = g.current_version_id
LEFT JOIN app_page p ON p.id = gv.page_id
WHERE g.enabled = TRUE
  AND g.status = 'published'
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at IS NULL OR gv.end_at >= now());
