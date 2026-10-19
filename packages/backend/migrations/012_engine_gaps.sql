-- ============================================================
-- 012 — Two engine gaps: hash-based routers, and help-center analytics.
--
-- 1. application.route_mode: how the app's router addresses pages.
--      'path'  /settings/team      (the default; matching uses location.pathname)
--      'hash'  /#/settings/team    (matching uses the path inside location.hash)
--    Plain text with a CHECK, like help_position, so a third mode later is
--    one constraint change rather than a type migration.
--
-- 2. Help-center events: 'help_opened' (the panel opened) and 'help_searched'
--    (a query was typed; metadata carries { query, results }). Neither belongs
--    to a guide, so guide_id becomes nullable — but ONLY for these two types.
--    The CHECK ties the two together both ways: a help event never names a
--    guide, and a guide event always does. The foreign keys stay as they are.
--
--    The CHECK compares event_type as text: a value added by ALTER TYPE in
--    the same transaction can't be referenced as an enum literal until it
--    commits ("unsafe use of new value"), and the migration runner applies
--    each file inside one transaction.
-- ============================================================

ALTER TABLE application
    ADD COLUMN route_mode TEXT NOT NULL DEFAULT 'path',
    ADD CONSTRAINT chk_route_mode CHECK (route_mode IN ('path', 'hash'));

ALTER TYPE guide_event_type ADD VALUE IF NOT EXISTS 'help_opened';
ALTER TYPE guide_event_type ADD VALUE IF NOT EXISTS 'help_searched';

ALTER TABLE guide_event ALTER COLUMN guide_id DROP NOT NULL;
ALTER TABLE guide_event
    ADD CONSTRAINT chk_help_event_has_no_guide CHECK (
        ((event_type::text IN ('help_opened', 'help_searched')) = (guide_id IS NULL))
        AND (guide_id IS NOT NULL OR guide_version_id IS NULL)
    );
