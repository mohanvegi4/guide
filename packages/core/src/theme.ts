/**
 * How guide cards and the help center look. The app's settings send it with
 * every /guides, /help and /preview answer:
 *   color      the app's color (help_button_color)
 *   matchSite  take the page's own Bootstrap 5 theme where it has one; the
 *              color is then only the fallback for pages without a theme
 *
 * It reaches the shadow DOMs as CSS custom properties on their host element.
 * Custom properties inherit through a shadow boundary, so with matchSite the
 * values are `var(--bs-…, <ours>)` expressions resolved against the page's
 * live theme (a per-tenant theme loaded at runtime, as in the WISE OPAC,
 * included). Nothing from the page is read by script.
 */
export interface GuideTheme {
  color: string;
  matchSite: boolean;
}

export const DEFAULT_THEME_COLOR = '#4f46e5';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Guide Engine's own look, used where a page has no theme to match. */
const OWN = {
  font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  text: '#111',
  bg: '#fff',
  radius: '6px',
} as const;

/**
 * The custom properties for a theme. The color is used only when it is a
 * plain hex value (it ends up in a style declaration); anything else falls
 * back to the default.
 */
export function themeProperties(theme: GuideTheme | null | undefined): Record<string, string> {
  const color = theme && HEX_COLOR.test(theme.color) ? theme.color : DEFAULT_THEME_COLOR;
  const site = (bootstrap: string, own: string) => (theme?.matchSite ? `var(--bs-${bootstrap}, ${own})` : own);
  return {
    '--ge-primary': site('primary', color),
    '--ge-font': site('body-font-family', OWN.font),
    '--ge-text': site('body-color', OWN.text),
    '--ge-bg': site('body-bg', OWN.bg),
    '--ge-radius': site('border-radius', OWN.radius),
  };
}

/** Sets a theme's custom properties on an element (a shadow host, or the spotlight). */
export function applyTheme(el: HTMLElement, theme: GuideTheme | null | undefined): void {
  for (const [name, value] of Object.entries(themeProperties(theme))) el.style.setProperty(name, value);
}

/** Whether two themes look the same (so the engine re-styles only on a change). */
export function sameTheme(a: GuideTheme | null, b: GuideTheme | null): boolean {
  return a?.color === b?.color && a?.matchSite === b?.matchSite;
}

/** A theme from an API answer, or null when it has none (an older backend). */
export function readTheme(data: { theme?: unknown } | null | undefined): GuideTheme | null {
  const t = data?.theme as { color?: unknown; matchSite?: unknown } | undefined;
  if (!t || typeof t.color !== 'string') return null;
  return { color: t.color, matchSite: t.matchSite === true };
}
