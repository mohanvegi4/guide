/** Parses a textarea of website URLs (one per line or comma-separated) into origins, or returns an error message. */
export function parseWebsites(text: string): string[] | string {
  const entries = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const origins: string[] = [];
  for (const entry of entries) {
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      origins.push(url.origin);
    } catch {
      return `"${entry}" isn't a website URL (expected e.g. https://app.example.com).`;
    }
  }
  return [...new Set(origins)];
}
