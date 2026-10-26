-- ============================================================
-- 003 — Guide cards and the help center can take the website's look.
--
-- match_site_theme on: the agent styles cards and the help center with the
-- page's own Bootstrap 5 theme (--bs-primary, --bs-body-font-family,
-- --bs-body-color, --bs-body-bg, --bs-border-radius), read in the browser,
-- so a site whose theme changes per tenant (the WISE OPAC's library themes)
-- gets each tenant's colors. help_button_color is then only the fallback,
-- for pages without such a theme. Off: help_button_color for the help button
-- and the cards' main buttons, and Guide Engine's own look otherwise.
--
-- On for every app, existing ones included: a page without Bootstrap looks
-- exactly as before, since every value falls back to the current one.
-- ============================================================

ALTER TABLE application ADD COLUMN match_site_theme BOOLEAN NOT NULL DEFAULT TRUE;
