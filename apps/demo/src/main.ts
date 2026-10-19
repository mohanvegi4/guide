import { GuideEngine, createDomRenderer } from '@guide-engine/core';

/**
 * Minimal host app for end-to-end checks of the SDK: two "routes", one
 * element tagged with data-guide-id, and a tiny pushState router that calls
 * engine.onRouteChange() the way the Angular/Vue wrappers do.
 */
const TOKEN_KEY = 'demo-end-user-token';
const token = sessionStorage.getItem(TOKEN_KEY);

const views: Record<string, string> = {
  '/dashboard': `<h1>Dashboard</h1><p>Your team is small. Grow it!</p>
    <button data-guide-id="invite-button">Invite teammates</button>`,
  '/projects': `<h1>Projects</h1><p>No projects yet.</p>
    <button data-guide-id="new-project">New project</button>`,
};

function render(path: string): void {
  document.getElementById('view')!.innerHTML = views[path] ?? `<h1>Not found</h1><p>${path}</p>`;
}

if (!token) {
  document.getElementById('login')!.hidden = false;
  document.getElementById('save-token')!.addEventListener('click', () => {
    const value = (document.getElementById('token') as HTMLTextAreaElement).value.trim();
    if (value) {
      sessionStorage.setItem(TOKEN_KEY, value);
      location.reload(); // keeps ?guidePreview=... in the URL
    }
  });
} else {
  const engine = new GuideEngine();
  const renderer = createDomRenderer({
    advanceStep: (id) => engine.advanceStep(id),
    dismissGuide: (id) => engine.dismissGuide(id),
  });

  const path = location.pathname === '/' ? '/dashboard' : location.pathname;
  if (path !== location.pathname) history.replaceState({}, '', path + location.search);
  render(path);

  void engine.init({ tenantId: 'from-token', userId: 'from-token', apiBaseUrl: 'http://localhost:3000', getAuthToken: () => token }, renderer);

  document.querySelectorAll<HTMLAnchorElement>('a[data-link]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      history.pushState({}, '', a.pathname);
      render(a.pathname);
      void engine.onRouteChange(a.pathname);
    })
  );
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    document.getElementById('who')!.textContent = `signed in as ${claims.userId}`;
  } catch {
    // display only
  }
}
