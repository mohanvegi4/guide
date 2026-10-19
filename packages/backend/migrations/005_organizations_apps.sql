-- ============================================================
-- 005 — From an OCLC-style tenant model to a public, Pendo-style product.
--
--   organization (a customer of Guide Engine; one Studio workspace)
--     └─ application (one product; has a PUBLIC key used by the install snippet)
--          └─ guide → guide_version (+ optional account allowlist)
--   studio_user ── org_member (owner|admin|member) / app_member (per-app role)
--   end users are VISITORS (and their ACCOUNTS), identified by the host app
--
-- Data is converted, not discarded:
--   * each tenant  -> an organization (same id) with one "Default app"
--   * tenant guides -> that app; the tenant id becomes the events' account_id
--     (an OCLC library is exactly what an "account" is in the new model)
--   * global guides -> a member-less "Migrated global guides" org for an
--     operator to reassign
--   * per-tenant kill switch -> application.enabled
--
-- RLS is rebuilt around org/app access. Every policy reads only session
-- variables that the backend sets after verifying the caller (see db.ts:
-- withStudioSession / withAgentSession / withIdentity), so no policy ever
-- queries a table whose own policy queries back (no recursion).
-- ============================================================

-- The app role owns these tables and FORCE RLS applies to it: switch FORCE
-- off for the duration of the data conversion (same transaction), then on.
ALTER TABLE guide            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE guide_version    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE guide_event      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE user_guide_state NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_config    NO FORCE ROW LEVEL SECURITY;

-- Old policies all reference tenant_id / is_global; drop every one of them.
DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename IN ('guide', 'guide_version', 'guide_event', 'user_guide_state', 'tenant_config')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I', p.policyname, p.tablename);
  END LOOP;
END $$;

DROP VIEW active_guide;

-- ------------------------------------------------------------
-- New tables
-- ------------------------------------------------------------
CREATE TYPE org_role      AS ENUM ('owner', 'admin', 'member');
CREATE TYPE app_role      AS ENUM ('viewer', 'editor', 'publisher', 'app_admin');
CREATE TYPE identity_mode AS ENUM ('optional', 'required');

CREATE TABLE studio_user (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    oidc_issuer     TEXT NOT NULL,
    oidc_sub        TEXT NOT NULL,
    email           TEXT,
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    name            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (oidc_issuer, oidc_sub)
);

CREATE TABLE organization (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_by  UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE application (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    -- PUBLIC by design: it ships in every page's <head>. It identifies the
    -- app; it does not authenticate anyone (see identity_mode).
    public_key       TEXT NOT NULL UNIQUE,
    -- Websites allowed to run the agent (CORS). Empty = none (fail closed).
    allowed_origins  TEXT[] NOT NULL DEFAULT '{}',
    -- 'required': visitors must present a JWT signed with signing_secret.
    identity_mode    identity_mode NOT NULL DEFAULT 'optional',
    signing_secret   TEXT,
    -- Per-app kill switch (replaces the per-tenant one).
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_required_identity_has_secret
        CHECK (identity_mode = 'optional' OR signing_secret IS NOT NULL)
);
CREATE INDEX idx_application_org ON application (org_id);

CREATE TABLE org_member (
    org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES studio_user(id) ON DELETE CASCADE,
    role        org_role NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_org_member_user ON org_member (user_id);

CREATE TABLE app_member (
    app_id      UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES studio_user(id) ON DELETE CASCADE,
    role        app_role NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, user_id)
);
CREATE INDEX idx_app_member_user ON app_member (user_id);

CREATE TABLE invitation (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    email        TEXT,
    org_role     org_role NOT NULL DEFAULT 'member',
    app_roles    JSONB NOT NULL DEFAULT '{}',   -- { "<app id>": "<app_role>" }
    token_hash   TEXT NOT NULL UNIQUE,          -- sha256 of the link token; the raw token is never stored
    created_by   UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    accepted_at  TIMESTAMPTZ,
    accepted_by  UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    CONSTRAINT chk_invite_not_owner CHECK (org_role <> 'owner')
);
CREATE INDEX idx_invitation_org ON invitation (org_id);

-- ------------------------------------------------------------
-- Data conversion
-- ------------------------------------------------------------
INSERT INTO organization (id, name, created_at)
SELECT id, name, created_at FROM tenant;

INSERT INTO application (org_id, name, public_key, enabled)
SELECT o.id, 'Default app', 'ge_pk_' || encode(gen_random_bytes(16), 'hex'),
       NOT EXISTS (
         SELECT 1 FROM tenant_config tc
         WHERE tc.tenant_id = o.id AND tc.key = 'guide_engine_enabled' AND tc.value = 'false'
       )
FROM organization o;

DO $$
DECLARE migrated_org UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM guide WHERE is_global) THEN
    INSERT INTO organization (name) VALUES ('Migrated global guides') RETURNING id INTO migrated_org;
    INSERT INTO application (org_id, name, public_key)
    VALUES (migrated_org, 'Global guides', 'ge_pk_' || encode(gen_random_bytes(16), 'hex'));
  END IF;
END $$;

-- guide -> app
ALTER TABLE guide ADD COLUMN app_id UUID REFERENCES application(id) ON DELETE CASCADE;
UPDATE guide g SET app_id = a.id FROM application a WHERE a.org_id = g.tenant_id;
UPDATE guide g SET app_id = a.id
FROM application a JOIN organization o ON o.id = a.org_id
WHERE g.is_global AND o.name = 'Migrated global guides' AND o.created_by IS NULL;
ALTER TABLE guide ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE guide DROP COLUMN tenant_id, DROP COLUMN is_global;   -- also drops chk_tenant_or_global, idx_guide_tenant
CREATE INDEX idx_guide_app ON guide (app_id);

-- guide_version: optional account allowlist (NULL = every account)
ALTER TABLE guide_version ADD COLUMN account_ids TEXT[];

-- guide_event: app + visitor + account
ALTER TABLE guide_event ADD COLUMN app_id UUID REFERENCES application(id) ON DELETE CASCADE;
ALTER TABLE guide_event ADD COLUMN account_id TEXT;
UPDATE guide_event e SET app_id = g.app_id, account_id = e.tenant_id::TEXT FROM guide g WHERE g.id = e.guide_id;
ALTER TABLE guide_event ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE guide_event RENAME COLUMN user_id TO visitor_id;
ALTER TABLE guide_event DROP COLUMN tenant_id;                   -- also drops idx_event_tenant_*
CREATE INDEX idx_event_app_guide ON guide_event (app_id, guide_id, occurred_at DESC);
CREATE INDEX idx_event_app_type  ON guide_event (app_id, event_type, occurred_at DESC);

-- user_guide_state: keyed by (app, visitor, guide). Former global guides
-- could hold the same user id under several tenants; keep the newest row.
ALTER TABLE user_guide_state ADD COLUMN app_id UUID REFERENCES application(id) ON DELETE CASCADE;
UPDATE user_guide_state s SET app_id = g.app_id FROM guide g WHERE g.id = s.guide_id;
DELETE FROM user_guide_state a
USING user_guide_state b
WHERE a.app_id = b.app_id AND a.user_id = b.user_id AND a.guide_id = b.guide_id
  AND (a.updated_at, a.tenant_id) < (b.updated_at, b.tenant_id);
ALTER TABLE user_guide_state DROP CONSTRAINT user_guide_state_pkey;
ALTER TABLE user_guide_state ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE user_guide_state RENAME COLUMN user_id TO visitor_id;
ALTER TABLE user_guide_state DROP COLUMN tenant_id;              -- also drops idx_user_guide_state_tenant_user
ALTER TABLE user_guide_state ADD PRIMARY KEY (app_id, visitor_id, guide_id);

DROP TABLE tenant_config;
DROP TABLE tenant;
DROP FUNCTION app_current_tenant_id();
DROP FUNCTION app_is_platform_admin();

-- ------------------------------------------------------------
-- Active guides view (security_invoker: respects the caller's RLS)
-- ------------------------------------------------------------
CREATE VIEW active_guide WITH (security_invoker = true) AS
SELECT g.id, g.app_id, g.name, g.type,
       gv.id AS version_id, gv.version_number, gv.steps, gv.route_match, gv.account_ids,
       gv.start_at, gv.end_at
FROM guide g
JOIN guide_version gv ON gv.id = g.current_version_id
WHERE g.enabled = TRUE
  AND g.status = 'published'
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at IS NULL OR gv.end_at >= now());

-- ------------------------------------------------------------
-- Session-variable accessors used by every policy. Each returns NULL / an
-- empty array when unset, so an unconfigured session matches nothing.
-- ------------------------------------------------------------
CREATE FUNCTION app_setting_uuid(name TEXT) RETURNS UUID
    LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting(name, true), '')::UUID $$;
CREATE FUNCTION app_setting_uuids(name TEXT) RETURNS UUID[]
    LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting(name, true), '')::UUID[], '{}') $$;
CREATE FUNCTION app_setting_text(name TEXT) RETURNS TEXT
    LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting(name, true), '') $$;

-- Studio: the signed-in Studio user, and what their memberships resolve to.
CREATE FUNCTION app_current_user_id()  RETURNS UUID   LANGUAGE sql STABLE AS $$ SELECT app_setting_uuid('app.current_user_id') $$;
CREATE FUNCTION app_org_ids()          RETURNS UUID[] LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.org_ids') $$;
CREATE FUNCTION app_admin_org_ids()    RETURNS UUID[] LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.admin_org_ids') $$;
CREATE FUNCTION app_app_ids()          RETURNS UUID[] LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.app_ids') $$;
CREATE FUNCTION app_admin_app_ids()    RETURNS UUID[] LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.admin_app_ids') $$;
-- Identity being provisioned/looked up: "<issuer>|<sub>" from a verified token.
CREATE FUNCTION app_current_identity() RETURNS TEXT   LANGUAGE sql STABLE AS $$ SELECT app_setting_text('app.current_identity') $$;
-- Invitation being accepted (sha256 of the link token the caller presented).
CREATE FUNCTION app_invite_token_hash() RETURNS TEXT  LANGUAGE sql STABLE AS $$ SELECT app_setting_text('app.invite_token_hash') $$;
-- Agent: the app resolved from a public key.
CREATE FUNCTION app_public_key()       RETURNS TEXT   LANGUAGE sql STABLE AS $$ SELECT app_setting_text('app.public_key') $$;
CREATE FUNCTION app_current_app_id()   RETURNS UUID   LANGUAGE sql STABLE AS $$ SELECT app_setting_uuid('app.current_app_id') $$;

-- ------------------------------------------------------------
-- Policies
-- ------------------------------------------------------------
-- studio_user: your own row (by verified identity or id), and co-members.
ALTER TABLE studio_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_user FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_user_select ON studio_user FOR SELECT USING (
    oidc_issuer || '|' || oidc_sub = app_current_identity()
    OR id = app_current_user_id()
    OR id IN (SELECT m.user_id FROM org_member m WHERE m.org_id = ANY(app_org_ids()))
    OR id IN (SELECT m.user_id FROM app_member m WHERE m.app_id = ANY(app_admin_app_ids()))
);
CREATE POLICY studio_user_insert ON studio_user FOR INSERT
    WITH CHECK (oidc_issuer || '|' || oidc_sub = app_current_identity());
CREATE POLICY studio_user_update ON studio_user FOR UPDATE
    USING (oidc_issuer || '|' || oidc_sub = app_current_identity())
    WITH CHECK (oidc_issuer || '|' || oidc_sub = app_current_identity());

-- organization
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_select ON organization FOR SELECT USING (
    id = ANY(app_org_ids())
    OR created_by = app_current_user_id()
    OR id IN (SELECT i.org_id FROM invitation i WHERE i.token_hash = app_invite_token_hash())
);
CREATE POLICY organization_insert ON organization FOR INSERT WITH CHECK (created_by = app_current_user_id());
CREATE POLICY organization_update ON organization FOR UPDATE
    USING (id = ANY(app_admin_org_ids())) WITH CHECK (id = ANY(app_admin_org_ids()));

-- application: Studio members; the agent (by public key, then by id).
ALTER TABLE application ENABLE ROW LEVEL SECURITY;
ALTER TABLE application FORCE ROW LEVEL SECURITY;
CREATE POLICY application_select ON application FOR SELECT USING (
    id = ANY(app_app_ids())
    OR org_id = ANY(app_admin_org_ids())
    OR public_key = app_public_key()
    OR id = app_current_app_id()
    -- someone holding an invitation link may see the org's apps it grants roles on
    OR org_id IN (SELECT i.org_id FROM invitation i WHERE i.token_hash = app_invite_token_hash())
);
CREATE POLICY application_insert ON application FOR INSERT WITH CHECK (org_id = ANY(app_admin_org_ids()));
CREATE POLICY application_update ON application FOR UPDATE
    USING (id = ANY(app_admin_app_ids())) WITH CHECK (id = ANY(app_admin_app_ids()));
CREATE POLICY application_delete ON application FOR DELETE USING (org_id = ANY(app_admin_org_ids()));

-- org_member
ALTER TABLE org_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_member FORCE ROW LEVEL SECURITY;
CREATE POLICY org_member_select ON org_member FOR SELECT
    USING (user_id = app_current_user_id() OR org_id = ANY(app_org_ids()));
CREATE POLICY org_member_insert ON org_member FOR INSERT WITH CHECK (
    org_id = ANY(app_admin_org_ids())
    -- Bootstrap: the creator becomes owner, only inside the transaction that
    -- created the org (now() is the transaction start time, which is also the
    -- org's created_at default) — so it can't be replayed later to regain access.
    OR (user_id = app_current_user_id() AND role = 'owner' AND EXISTS (
          SELECT 1 FROM organization o
          WHERE o.id = org_member.org_id AND o.created_by = app_current_user_id() AND o.created_at = now()))
    -- Invitation: exactly the role the (valid, unused) invitation grants.
    OR (user_id = app_current_user_id() AND EXISTS (
          SELECT 1 FROM invitation i
          WHERE i.org_id = org_member.org_id AND i.token_hash = app_invite_token_hash()
            AND i.accepted_at IS NULL AND i.expires_at > now() AND i.org_role = org_member.role))
);
CREATE POLICY org_member_update ON org_member FOR UPDATE
    USING (org_id = ANY(app_admin_org_ids())) WITH CHECK (org_id = ANY(app_admin_org_ids()));
CREATE POLICY org_member_delete ON org_member FOR DELETE
    USING (org_id = ANY(app_admin_org_ids()) OR user_id = app_current_user_id());

-- app_member
ALTER TABLE app_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_member FORCE ROW LEVEL SECURITY;
CREATE POLICY app_member_select ON app_member FOR SELECT
    USING (user_id = app_current_user_id() OR app_id = ANY(app_admin_app_ids()) OR app_id = ANY(app_app_ids()));
CREATE POLICY app_member_insert ON app_member FOR INSERT WITH CHECK (
    app_id = ANY(app_admin_app_ids())
    OR (user_id = app_current_user_id() AND EXISTS (
          SELECT 1 FROM invitation i JOIN application a ON a.org_id = i.org_id
          WHERE a.id = app_member.app_id AND i.token_hash = app_invite_token_hash()
            AND i.accepted_at IS NULL AND i.expires_at > now()
            AND i.app_roles ->> app_member.app_id::TEXT = app_member.role::TEXT))
);
CREATE POLICY app_member_update ON app_member FOR UPDATE
    USING (app_id = ANY(app_admin_app_ids())) WITH CHECK (app_id = ANY(app_admin_app_ids()));
CREATE POLICY app_member_delete ON app_member FOR DELETE
    USING (app_id = ANY(app_admin_app_ids()) OR user_id = app_current_user_id());

-- invitation: org admins manage; the holder of the link can read and accept it.
ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_select ON invitation FOR SELECT
    USING (org_id = ANY(app_admin_org_ids()) OR token_hash = app_invite_token_hash());
CREATE POLICY invitation_insert ON invitation FOR INSERT WITH CHECK (org_id = ANY(app_admin_org_ids()));
CREATE POLICY invitation_update ON invitation FOR UPDATE
    USING (org_id = ANY(app_admin_org_ids()) OR token_hash = app_invite_token_hash())
    WITH CHECK (org_id = ANY(app_admin_org_ids()) OR token_hash = app_invite_token_hash());
CREATE POLICY invitation_delete ON invitation FOR DELETE USING (org_id = ANY(app_admin_org_ids()));

-- guide: Studio members of the app read/write; the agent reads its own app.
ALTER TABLE guide FORCE ROW LEVEL SECURITY;
CREATE POLICY guide_studio ON guide
    USING (app_id = ANY(app_app_ids())) WITH CHECK (app_id = ANY(app_app_ids()));
CREATE POLICY guide_agent_select ON guide FOR SELECT USING (app_id = app_current_app_id());

-- guide_version: visible iff its guide is (the EXISTS runs under guide's RLS);
-- published versions are immutable (only drafts may change or be deleted).
ALTER TABLE guide_version FORCE ROW LEVEL SECURITY;
CREATE POLICY guide_version_select ON guide_version FOR SELECT
    USING (EXISTS (SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id));
CREATE POLICY guide_version_insert ON guide_version FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.app_id = ANY(app_app_ids())));
CREATE POLICY guide_version_update ON guide_version FOR UPDATE
    USING (published_at IS NULL AND EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.app_id = ANY(app_app_ids())))
    WITH CHECK (EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.app_id = ANY(app_app_ids())));
CREATE POLICY guide_version_delete ON guide_version FOR DELETE
    USING (published_at IS NULL AND EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.app_id = ANY(app_app_ids())));

-- guide_event: the agent writes its own app's events; Studio members read them.
ALTER TABLE guide_event FORCE ROW LEVEL SECURITY;
CREATE POLICY guide_event_agent_insert ON guide_event FOR INSERT WITH CHECK (app_id = app_current_app_id());
CREATE POLICY guide_event_studio_select ON guide_event FOR SELECT USING (app_id = ANY(app_app_ids()));

-- user_guide_state: written and read by the agent for its own app.
ALTER TABLE user_guide_state FORCE ROW LEVEL SECURITY;
CREATE POLICY user_guide_state_agent ON user_guide_state
    USING (app_id = app_current_app_id()) WITH CHECK (app_id = app_current_app_id());
