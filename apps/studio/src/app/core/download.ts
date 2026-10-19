import { HttpResponse } from '@angular/common/http';

/**
 * Hands a downloaded file to the browser. A plain `<a href>` can't be used
 * for API downloads: it wouldn't carry the bearer token the interceptor adds,
 * so the file comes through HttpClient as a Blob and is saved from here. The
 * name comes from the response's Content-Disposition when present.
 */
export function saveResponseAsFile(response: HttpResponse<Blob>, fallbackName: string): void {
  if (!response.body) return;
  const url = URL.createObjectURL(response.body);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFrom(response.headers.get('content-disposition')) ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** `attachment; filename="x.json"` → `x.json`; null when the header names no file. */
export function filenameFrom(contentDisposition: string | null): string | null {
  const match = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : null;
}
