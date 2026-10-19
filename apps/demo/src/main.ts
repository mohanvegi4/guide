/**
 * Minimal host app. Note what's NOT here: no Guide Engine import, no router
 * hooks. The install snippet in index.html loads the agent, and the agent
 * follows history.pushState navigation on its own.
 */
interface GuideEngineApi {
  identify(options: { visitor: { id: string }; account?: { id: string } | null }): void;
}
declare global {
  interface Window {
    guideEngine: GuideEngineApi;
  }
}

const views: Record<string, string> = {
  '/dashboard': `<h1>Dashboard</h1><p>Your team is small. Grow it!</p>
    <button data-guide-id="invite-button">Invite teammates</button>`,
  '/projects': `<h1>Projects</h1><p>No projects yet.</p>
    <button data-guide-id="new-project">New project</button>`,
  '/team': `<h1>Team</h1><p>2 members.</p>
    <button data-guide-id="add-member">Add member</button>`,
};

function render(path: string): void {
  document.getElementById('view')!.innerHTML = views[path] ?? `<h1>Not found</h1><p>${path}</p>`;
}

if (location.pathname === '/') history.replaceState({}, '', '/dashboard');
render(location.pathname);
addEventListener('popstate', () => render(location.pathname));

document.querySelectorAll<HTMLAnchorElement>('a[data-link]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState({}, '', a.pathname); // the agent notices this by itself
    render(a.pathname);
  })
);

// "Sign in": the host app tells Guide Engine who the user is.
const form = document.getElementById('who') as HTMLFormElement;
const current = document.getElementById('current')!;
function showWho(): void {
  const who = JSON.parse(localStorage.getItem('demo-user') ?? 'null');
  current.textContent = who ? `signed in as ${who.visitor}${who.account ? ` @ ${who.account}` : ''}` : 'anonymous';
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const visitor = String(data.get('visitor') ?? '').trim();
  const account = String(data.get('account') ?? '').trim();
  if (!visitor) return;
  localStorage.setItem('demo-user', JSON.stringify({ visitor, account: account || null }));
  window.guideEngine.identify({ visitor: { id: visitor }, account: account ? { id: account } : null });
  showWho();
});
showWho();

if (import.meta.env.VITE_GE_APP_KEY === undefined) document.getElementById('setup')!.hidden = false;

export {};
