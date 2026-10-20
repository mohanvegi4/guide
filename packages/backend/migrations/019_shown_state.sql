-- ============================================================
-- 019 — Automatic guides show once per visitor.
--
-- user_guide_state recorded only dismissals and completions, so a visitor
-- who reloaded mid-guide (or navigated away) got the guide again from the
-- start on every page load. A guide_shown event now records 'shown', and
-- /guides skips shown guides like finished ones — until a newer version is
-- published. The help center is unaffected: it lists guides regardless of
-- state, so a visitor can always replay one on demand.
-- ============================================================

ALTER TYPE user_guide_status ADD VALUE IF NOT EXISTS 'shown';
