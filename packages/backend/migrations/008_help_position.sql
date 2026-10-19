-- ============================================================
-- 008 — Help center placement, per app: where the topic list (and the
-- "Go to another page?" confirmation, which always joins it) appears.
-- One of the four corners, or the center of the screen. The floating
-- button sits in the chosen corner; for 'center' it stays bottom right.
-- Plain text with a CHECK (not an enum) so adding a placement later is one
-- constraint change, not a type migration.
-- ============================================================

ALTER TABLE application
    ADD COLUMN help_position TEXT NOT NULL DEFAULT 'bottom-right',
    ADD CONSTRAINT chk_help_position
        CHECK (help_position IN ('bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'));
