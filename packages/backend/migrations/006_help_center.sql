-- ============================================================
-- 006 — Help center: a searchable list of guides a visitor can start on
-- demand (the floating help button, or guideEngine.openHelp()).
--
-- Authors opt a guide in per version (so it is previewed, published and
-- rolled back together with the guide's content and route):
--   guide_version.help = { title, description, keywords[], startPath } | NULL
-- NULL = not listed in the help center.
--
-- Per app: whether the help center is on, and the default button's look.
-- ============================================================

ALTER TABLE guide_version ADD COLUMN help JSONB;

ALTER TABLE application
    ADD COLUMN help_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN help_button_label TEXT    NOT NULL DEFAULT 'Help',
    ADD COLUMN help_button_color TEXT    NOT NULL DEFAULT '#4f46e5',
    -- The color is injected into the agent's stylesheet: only allow a plain
    -- hex color so it can never carry CSS.
    ADD CONSTRAINT chk_help_button_color CHECK (help_button_color ~ '^#[0-9a-fA-F]{6}$'),
    ADD CONSTRAINT chk_help_button_label CHECK (char_length(help_button_label) BETWEEN 1 AND 40);

-- Expose the help metadata on the active-guides view (new columns go last,
-- so CREATE OR REPLACE keeps the view's identity and grants).
CREATE OR REPLACE VIEW active_guide WITH (security_invoker = true) AS
SELECT g.id, g.app_id, g.name, g.type,
       gv.id AS version_id, gv.version_number, gv.steps, gv.route_match, gv.account_ids,
       gv.start_at, gv.end_at,
       gv.help
FROM guide g
JOIN guide_version gv ON gv.id = g.current_version_id
WHERE g.enabled = TRUE
  AND g.status = 'published'
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at IS NULL OR gv.end_at >= now());
