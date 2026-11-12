import sanitizeHtml from 'sanitize-html';

/**
 * Server-side sanitization for author-supplied guide content.
 *
 * The SDK's DOM renderer injects step.content as HTML into a shadow root
 * inside the host product, i.e. into a page where the END USER is logged in.
 * Anything an author (or a compromised author account) saves here runs in
 * every end user's session, so content is sanitized on the write path, before
 * it is persisted — the renderer relies on that and does not re-sanitize.
 *
 * sanitize-html (not DOMPurify) because it needs no DOM: it's a parser-based
 * allowlist that runs directly in Node.
 */
const STEP_CONTENT_OPTIONS: sanitizeHtml.IOptions = {
  // Allowlist: simple formatting only. No script/style/iframe/object/form,
  // which also means no inline <style> that could restyle the host page.
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'b',
    'i',
    'u',
    's',
    'a',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'code',
    'pre',
    'blockquote',
    'span',
    'img',
  ],
  // No `style` and no event-handler (on*) attributes anywhere.
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Images load over http(s) only — no data: URIs (tracking pixels / payload smuggling).
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  // Dropped elements' text is kept (e.g. <font>Hi</font> -> Hi), but the
  // body of script/style-like tags is discarded entirely.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
  transformTags: {
    // Links open in a new tab without giving the target page a handle on the
    // host app's window (reverse tabnabbing).
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
    }),
  },
};

export function sanitizeStepContent(html: string): string {
  return sanitizeHtml(html, STEP_CONTENT_OPTIONS).trim();
}

/**
 * For fields rendered as text (e.g. action button labels): strip all markup.
 * The renderer also sets these via textContent, so this is defense in depth
 * and keeps stored data clean for any other consumer.
 */
export function sanitizePlainText(text: string): string {
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }).trim();
}
