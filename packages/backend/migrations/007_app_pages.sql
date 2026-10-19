-- ============================================================
-- 007 — Reusable pages: a per-app library of named URL rules
-- ("Team settings" -> /settings/team) that guides pick instead of typing a
-- route each time. Like Pendo's tagged pages.
--
-- Guides REFERENCE a page (guide_version.page_id): editing the page's URL
-- updates every live guide on it at once, with no republishing. Each version
-- still stores a snapshot of the route (route_match) as a fallback, so if a
-- page is ever deleted, old versions keep a sensible route.
-- ============================================================

CREATE TYPE page_match_type AS ENUM ('exact', 'pattern');

CREATE TABLE app_page (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id       UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    match_type   page_match_type NOT NULL,
    match_value  TEXT NOT NULL CHECK (match_value LIKE '/%'),
    -- Where the help center sends visitors for guides on this page. Required
    -- for patterns (there's no single page to open); defaults to the exact
    -- path otherwise. Same-site paths only.
    start_path   TEXT CHECK (start_path IS NULL OR (start_path LIKE '/%' AND start_path NOT LIKE '//%')),
    created_by   UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_pattern_has_start CHECK (match_type = 'exact' OR start_path IS NOT NULL)
);
CREATE UNIQUE INDEX uq_app_page_name ON app_page (app_id, lower(name));
CREATE INDEX idx_app_page_app ON app_page (app_id);

-- ON DELETE SET NULL: deleting a page (only allowed when no live guide or
-- draft uses it — enforced by the API) leaves older versions on their
-- route snapshot. Referential actions run as the table owner and bypass RLS,
-- so the "published versions are immutable" policy doesn't block this one
-- system-made change.
ALTER TABLE guide_version ADD COLUMN page_id UUID REFERENCES app_page(id) ON DELETE SET NULL;
CREATE INDEX idx_guide_version_page ON guide_version (page_id) WHERE page_id IS NOT NULL;

-- RLS: Studio members of the app manage its pages (roles enforced in the
-- API); the agent reads its own app's pages (to resolve guide routes).
ALTER TABLE app_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_page FORCE ROW LEVEL SECURITY;
CREATE POLICY app_page_studio ON app_page
    USING (app_id = ANY(app_app_ids())) WITH CHECK (app_id = ANY(app_app_ids()));
CREATE POLICY app_page_agent_select ON app_page FOR SELECT USING (app_id = app_current_app_id());

-- Active guides now resolve their route through the page, if any. Same
-- columns as before (route_match is still jsonb), plus the page's start path.
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
       COALESCE(p.start_path, CASE WHEN p.match_type = 'exact' THEN p.match_value END) AS page_start_path
FROM guide g
JOIN guide_version gv ON gv.id = g.current_version_id
LEFT JOIN app_page p ON p.id = gv.page_id
WHERE g.enabled = TRUE
  AND g.status = 'published'
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at IS NULL OR gv.end_at >= now());
