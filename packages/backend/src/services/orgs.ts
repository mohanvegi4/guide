import { PoolClient } from 'pg';
import { StudioContext, resolveStudioContext } from '../db';
import { generatePublicKey } from '../keys';

/**
 * Creates an organization, makes the creator its owner, and creates its first
 * application. Used by POST /v1/orgs (self-serve sign-up) and the seed script.
 * Runs inside a Studio session; refreshes the session's scope after the
 * owner membership exists so the app insert passes RLS.
 */
export async function createOrgWithApp(
  client: PoolClient,
  ctx: StudioContext,
  input: { name: string; app: { name: string; websites: string[] } },
): Promise<{ org: { id: string; name: string }; app: AppRow; ctx: StudioContext }> {
  const org = (
    await client.query<{ id: string; name: string }>(
      `INSERT INTO organization (name, created_by) VALUES ($1, $2) RETURNING id, name`,
      [input.name, ctx.userId],
    )
  ).rows[0];
  await client.query(`INSERT INTO org_member (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    org.id,
    ctx.userId,
  ]);
  // Now an owner: refresh the session scope so the app insert passes RLS...
  await resolveStudioContext(client, ctx.userId);
  const app = await createApp(client, org.id, input.app);
  // ...and again so the returned context includes the new app.
  return { org, app, ctx: await resolveStudioContext(client, ctx.userId) };
}

export interface AppRow {
  id: string;
  org_id: string;
  name: string;
  public_key: string;
  allowed_origins: string[];
  identity_mode: 'optional' | 'required';
  has_signing_secret: boolean;
  enabled: boolean;
  help_enabled: boolean;
  help_button_label: string;
  help_button_color: string;
  help_position: HelpPosition;
  created_at: string;
}

/** Where the help list (and its confirmation) appears: a corner, or mid-screen. */
export const HELP_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'] as const;
export type HelpPosition = (typeof HELP_POSITIONS)[number];

export const APP_COLUMNS = `id, org_id, name, public_key, allowed_origins, identity_mode,
  signing_secret IS NOT NULL AS has_signing_secret, enabled,
  help_enabled, help_button_label, help_button_color, help_position, created_at`;

export async function createApp(
  client: PoolClient,
  orgId: string,
  input: { name: string; websites: string[] },
): Promise<AppRow> {
  const result = await client.query<AppRow>(
    `INSERT INTO application (org_id, name, public_key, allowed_origins)
     VALUES ($1, $2, $3, $4) RETURNING ${APP_COLUMNS}`,
    [orgId, input.name, generatePublicKey(), input.websites],
  );
  return result.rows[0];
}

/**
 * Where browsers reach this API (scheme + host). Used for the agent script
 * URL in install snippets. Defaults to localhost for development.
 */
export function publicApiUrl(): string {
  return (process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');
}

/** The exact snippet an app's pages put in <head> (shown in Studio → App settings). */
export function installSnippet(publicKey: string): string {
  return `<script>
(function(w,d,k){var g=w.guideEngine=w.guideEngine||{_q:[]};
['initialize','identify','openHelp','closeHelp','toggleHelp'].forEach(function(m){g[m]=g[m]||function(){g._q.push([m].concat([].slice.call(arguments)))}});
var s=d.createElement('script');s.async=1;s.src='${publicApiUrl()}/agent/v1/'+k+'/guides.js';d.head.appendChild(s);
})(window,document,'${publicKey}');
guideEngine.initialize({
  visitor: { id: 'USER_ID' },      // your signed-in user's id
  account: { id: 'ACCOUNT_ID' }    // optional: their company / customer id
  // helpButton: false             // hide the floating help button (call guideEngine.openHelp() from your own)
});
</script>`;
}
