-- ============================================================
-- 001 — The Guide Engine schema.
--
-- Migrations 001–021 squashed into one file before the first production
-- deployment; they had only ever run on development databases. The result is
-- the same schema they built, object for object (a schema dump of both
-- matched exactly). Their history, and why each step was taken, is in git and
-- in docs/architecture.md (§5.3).
--
-- From here on the usual rule applies again: never edit a migration that has
-- been applied anywhere; add a new numbered file.
--
-- Layout:
--   1. Types
--   2. Session helpers (the only thing RLS policies read)
--   3. People and organizations
--   4. Applications, their environments and saved pages
--   5. Guides, versions and releases
--   6. What visitors did: events and per-visitor state
--   7. Operations: agent errors, support access, rate limits, global config
--   8. The active_guide view
--   9. Row-level security
--  10. Seed rows
--
-- Every table under an organization references its parent with ON DELETE
-- CASCADE, so deleting an organization (or an app) removes everything in it.
-- Referential actions run as the table owner and bypass row-level security:
-- one DELETE on the organization takes its events and published versions
-- with it, without any session being allowed to delete those directly.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1. Types
-- ------------------------------------------------------------

CREATE TYPE guide_type AS ENUM ('tooltip', 'modal', 'banner', 'tour', 'checklist', 'survey', 'beacon');
CREATE TYPE guide_status AS ENUM ('draft', 'published', 'archived');
-- 'snoozed' is unused; enum values can't be dropped cheaply, so it stays.
CREATE TYPE user_guide_status AS ENUM ('dismissed', 'completed', 'snoozed', 'shown');
CREATE TYPE guide_event_type AS ENUM (
    'guide_shown', 'guide_step_viewed', 'guide_step_completed', 'guide_dismissed',
    'guide_completed', 'guide_error', 'survey_response', 'help_opened', 'help_searched'
);
CREATE TYPE identity_mode AS ENUM ('optional', 'required');
-- One organization-wide role per person: owner > manager > editor > viewer.
-- 'admin' and 'member' are retired values; CHECK constraints keep them out of
-- every table.
CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member', 'manager', 'editor', 'viewer');
-- Per-app roles of the retired app_member table.
CREATE TYPE app_role AS ENUM ('viewer', 'editor', 'publisher', 'app_admin');
CREATE TYPE page_match_type AS ENUM ('exact', 'pattern');

-- ------------------------------------------------------------
-- 2. Session helpers
--
-- Policies read only session variables, set per transaction by
-- withStudioSession / withAgentSession / withPlatformSession / withSupportSession
-- (src/db.ts). They never read membership tables, so a policy can't recurse
-- through another table's policy. An unset variable reads as NULL / empty.
-- ------------------------------------------------------------

CREATE FUNCTION app_setting_text(name TEXT) RETURNS TEXT
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting(name, true), '') $$;

CREATE FUNCTION app_setting_uuid(name TEXT) RETURNS UUID
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting(name, true), '')::UUID $$;

CREATE FUNCTION app_setting_uuids(name TEXT) RETURNS UUID[]
    LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(NULLIF(current_setting(name, true), '')::UUID[], '{}') $$;

-- Studio sessions: who is signed in, and what they may reach.
CREATE FUNCTION app_current_user_id() RETURNS UUID
    LANGUAGE sql STABLE AS $$ SELECT app_setting_uuid('app.current_user_id') $$;
-- "issuer|sub" of a signed-in user before their studio_user row exists.
CREATE FUNCTION app_current_identity() RETURNS TEXT
    LANGUAGE sql STABLE AS $$ SELECT app_setting_text('app.current_identity') $$;
-- Organizations the user belongs to, and those they run (manager or owner).
CREATE FUNCTION app_org_ids() RETURNS UUID[]
    LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.org_ids') $$;
CREATE FUNCTION app_admin_org_ids() RETURNS UUID[]
    LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.admin_org_ids') $$;
CREATE FUNCTION app_owner_org_ids() RETURNS UUID[]
    LANGUAGE sql STABLE AS $$
    SELECT app_setting_uuids('app.owner_org_ids')
$$;
-- Apps the user can see, can edit (editor and up), and can manage (manager and up).
CREATE FUNCTION app_app_ids() RETURNS UUID[]
    LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.app_ids') $$;
CREATE FUNCTION app_admin_app_ids() RETURNS UUID[]
    LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.admin_app_ids') $$;
CREATE FUNCTION app_manager_app_ids() RETURNS UUID[]
    LANGUAGE sql STABLE AS $$ SELECT app_setting_uuids('app.manager_app_ids') $$;
-- The hash of the invitation token being looked at or accepted.
CREATE FUNCTION app_invite_token_hash() RETURNS TEXT
    LANGUAGE sql STABLE AS $$ SELECT app_setting_text('app.invite_token_hash') $$;
-- Guide Engine staff. NULL (not false) when unset: test it with IS TRUE / IS NOT TRUE.
CREATE FUNCTION app_platform_admin() RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$
    SELECT app_setting_text('app.platform_admin') = 'true'
$$;

-- Agent sessions: the one app a public key resolved to.
CREATE FUNCTION app_current_app_id() RETURNS UUID
    LANGUAGE sql STABLE AS $$ SELECT app_setting_uuid('app.current_app_id') $$;
-- Looking an app up by its public key, before its id is known.
CREATE FUNCTION app_public_key() RETURNS TEXT
    LANGUAGE sql STABLE AS $$ SELECT app_setting_text('app.public_key') $$;

-- The retention job (deletes old events and agent errors).
CREATE FUNCTION app_retention() RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$
    SELECT app_setting_text('app.retention') = 'true'
$$;

-- ------------------------------------------------------------
-- 3. People and organizations
-- ------------------------------------------------------------

-- Everyone who has signed in to the Studio (OIDC identity only; roles live
-- below). Created on first sign-in. platform_admin marks Guide Engine staff;
-- it is granted by SQL or by another platform admin, never by oneself.
CREATE TABLE studio_user (
    id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    oidc_issuer    TEXT NOT NULL,
    oidc_sub       TEXT NOT NULL,
    email          TEXT,
    email_verified BOOLEAN DEFAULT FALSE NOT NULL,
    name           TEXT,
    created_at     TIMESTAMPTZ DEFAULT now() NOT NULL,
    last_seen_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
    platform_admin BOOLEAN DEFAULT FALSE NOT NULL,
    UNIQUE (oidc_issuer, oidc_sub)
);

-- A customer. suspended_at: a platform admin stopped its apps serving guides.
-- support_access_until: the owner opened read-only support access (≤ 90 days).
CREATE TABLE organization (
    id                        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name                      TEXT NOT NULL,
    created_by                UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    created_at                TIMESTAMPTZ DEFAULT now() NOT NULL,
    suspended_at              TIMESTAMPTZ,
    support_access_until      TIMESTAMPTZ,
    support_access_granted_by UUID REFERENCES studio_user(id) ON DELETE SET NULL
);

-- One role per person per organization, applying to every app of it.
CREATE TABLE org_member (
    org_id     UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES studio_user(id) ON DELETE CASCADE,
    role       org_role NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    PRIMARY KEY (org_id, user_id),
    CONSTRAINT chk_org_member_role CHECK (role IN ('owner', 'manager', 'editor', 'viewer'))
);
CREATE INDEX idx_org_member_user ON org_member (user_id);

-- Invite links: only the SHA-256 of the token is stored. Owners are promoted
-- from the member list, never invited. app_roles is unused (per-app grants
-- were retired).
CREATE TABLE invitation (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    email       TEXT,
    org_role    org_role DEFAULT 'viewer' NOT NULL,
    app_roles   JSONB DEFAULT '{}' NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_by  UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    accepted_by UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    CONSTRAINT chk_invitation_role CHECK (org_role IN ('manager', 'editor', 'viewer')),
    CONSTRAINT chk_invite_not_owner CHECK (org_role <> 'owner')
);
CREATE INDEX idx_invitation_org ON invitation (org_id);

-- ------------------------------------------------------------
-- 4. Applications, their environments and saved pages
-- ------------------------------------------------------------

-- An app installs the snippet with its public key. allowed_origins is the
-- union of its environments' websites (the API keeps it in sync); the agent's
-- CORS check reads it. signing_secret is encrypted at rest when SECRETS_KEY is
-- set; an app that requires signed identity must have one.
CREATE TABLE application (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id            UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    public_key        TEXT NOT NULL UNIQUE,
    allowed_origins   TEXT[] DEFAULT '{}' NOT NULL,
    identity_mode     identity_mode DEFAULT 'optional' NOT NULL,
    signing_secret    TEXT,
    enabled           BOOLEAN DEFAULT TRUE NOT NULL,
    created_at        TIMESTAMPTZ DEFAULT now() NOT NULL,
    help_enabled      BOOLEAN DEFAULT TRUE NOT NULL,
    help_button_label TEXT DEFAULT 'Help' NOT NULL,
    -- Injected into the agent's stylesheet, hence the strict format.
    help_button_color TEXT DEFAULT '#4f46e5' NOT NULL,
    help_position     TEXT DEFAULT 'bottom-right' NOT NULL,
    suspended_at      TIMESTAMPTZ,
    route_mode        TEXT DEFAULT 'path' NOT NULL,
    CONSTRAINT chk_help_button_color CHECK (help_button_color ~ '^#[0-9a-fA-F]{6}$'),
    CONSTRAINT chk_help_button_label CHECK (char_length(help_button_label) BETWEEN 1 AND 40),
    CONSTRAINT chk_help_position CHECK (help_position IN ('bottom-right', 'bottom-left', 'top-right', 'top-left', 'center')),
    CONSTRAINT chk_required_identity_has_secret CHECK (identity_mode = 'optional' OR signing_secret IS NOT NULL),
    CONSTRAINT chk_route_mode CHECK (route_mode IN ('path', 'hash'))
);
CREATE INDEX idx_application_org ON application (org_id);

-- Editors may update an app's settings, but only a manager (or a platform
-- admin) may change its key or signing secret. RLS can't tell columns apart,
-- so a trigger does.
CREATE FUNCTION application_guard_keys() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- app_platform_admin() is NULL (not false) in a session that never set it,
    -- so test it with IS NOT TRUE: NULL must mean "refuse", never "allow".
    IF (NEW.public_key IS DISTINCT FROM OLD.public_key
        OR NEW.signing_secret IS DISTINCT FROM OLD.signing_secret)
       AND NEW.id <> ALL(app_manager_app_ids())
       AND app_platform_admin() IS NOT TRUE THEN
        RAISE EXCEPTION 'only a manager may rotate an application''s key or signing secret'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER application_guard_keys BEFORE UPDATE OF public_key, signing_secret ON application
    FOR EACH ROW EXECUTE FUNCTION application_guard_keys();

-- Per-app roles from before the organization-wide role. Empty and unused.
CREATE TABLE app_member (
    app_id     UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES studio_user(id) ON DELETE CASCADE,
    role       app_role NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    PRIMARY KEY (app_id, user_id)
);
CREATE INDEX idx_app_member_user ON app_member (user_id);

-- Saved pages: named URL rules guides can share; editing one moves every
-- guide on it. A pattern needs a start page (where the help center sends
-- visitors), which must be a path on the app's own site.
CREATE TABLE app_page (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    app_id      UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    match_type  page_match_type NOT NULL,
    match_value TEXT NOT NULL CHECK (match_value LIKE '/%'),
    start_path  TEXT CHECK (start_path IS NULL OR (start_path LIKE '/%' AND start_path NOT LIKE '//%')),
    created_by  UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT chk_pattern_has_start CHECK (match_type = 'exact' OR start_path IS NOT NULL)
);
CREATE INDEX idx_app_page_app ON app_page (app_id);
CREATE UNIQUE INDEX uq_app_page_name ON app_page (app_id, lower(name));

-- Release stages (e.g. Dev → Test → Accept → Prod). The highest position is
-- production. Each owns its websites: the agent tells a request's environment
-- from its Origin, so a website belongs to one environment only (enforced by
-- the API). Positions are unique per app, checked at commit so a reorder can
-- swap two inside one transaction.
CREATE TABLE app_environment (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    app_id            UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    position          INTEGER NOT NULL CHECK (position >= 1),
    origins           TEXT[] DEFAULT '{}' NOT NULL,
    -- Off: no guide_event rows are stored for it (show-once state still is).
    analytics_enabled BOOLEAN DEFAULT TRUE NOT NULL,
    created_at        TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT uq_app_environment_position UNIQUE (app_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX uq_app_environment_name ON app_environment (app_id, lower(name));
CREATE INDEX idx_app_environment_origins ON app_environment USING gin (origins);

-- ------------------------------------------------------------
-- 5. Guides, versions and releases
-- ------------------------------------------------------------

-- current_version_id mirrors the production release (see guide_release).
CREATE TABLE guide (
    id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name               TEXT NOT NULL,
    type               guide_type NOT NULL,
    status             guide_status DEFAULT 'draft' NOT NULL,
    enabled            BOOLEAN DEFAULT FALSE NOT NULL,
    current_version_id UUID,
    created_by         TEXT NOT NULL,
    created_at         TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at         TIMESTAMPTZ DEFAULT now() NOT NULL,
    app_id             UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE
);
CREATE INDEX idx_guide_app ON guide (app_id);
CREATE INDEX idx_guide_enabled ON guide (enabled) WHERE enabled = TRUE;

-- Numbered versions. published_at NULL is the draft (at most one per guide);
-- published rows are immutable (the update policy only matches drafts), so
-- what was previewed is what ships. A version shows on a saved page (page_id;
-- route_match is then a snapshot of the page's route) or on a custom route.
-- account_ids / visitor_tags: NULL means everyone. activation 'manual' guides
-- only start from the help center, so they must be listed there.
CREATE TABLE guide_version (
    id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    guide_id       UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    steps          JSONB DEFAULT '[]' NOT NULL,
    route_match    JSONB DEFAULT '{}' NOT NULL,
    start_at       TIMESTAMPTZ,
    end_at         TIMESTAMPTZ,
    published_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT now() NOT NULL,
    account_ids    TEXT[],
    help           JSONB,
    page_id        UUID REFERENCES app_page(id) ON DELETE SET NULL,
    activation     TEXT DEFAULT 'auto' NOT NULL,
    visitor_tags   TEXT[],
    UNIQUE (guide_id, version_number),
    CONSTRAINT chk_guide_version_activation CHECK (activation IN ('auto', 'manual')),
    CONSTRAINT chk_guide_version_visitor_tags CHECK (visitor_tags IS NULL OR cardinality(visitor_tags) BETWEEN 1 AND 100),
    CONSTRAINT chk_manual_needs_help CHECK (activation = 'auto' OR help IS NOT NULL)
);
CREATE INDEX idx_guide_version_guide ON guide_version (guide_id);
CREATE INDEX idx_guide_version_page ON guide_version (page_id) WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX uq_guide_version_one_draft ON guide_version (guide_id) WHERE published_at IS NULL;

ALTER TABLE guide ADD CONSTRAINT fk_guide_current_version
    FOREIGN KEY (current_version_id) REFERENCES guide_version(id) ON DELETE SET NULL;

-- An early normalized steps table that was never used (steps live in
-- guide_version.steps).
CREATE TABLE step (
    id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    guide_version_id UUID NOT NULL REFERENCES guide_version(id) ON DELETE CASCADE,
    step_order       INTEGER NOT NULL,
    type             guide_type NOT NULL,
    target_selector  TEXT,
    content          TEXT NOT NULL,
    position         TEXT,
    actions          JSONB DEFAULT '[]' NOT NULL,
    UNIQUE (guide_version_id, step_order)
);
CREATE INDEX idx_step_guide_version ON step (guide_version_id);

-- The one published version each environment runs.
CREATE TABLE guide_release (
    guide_id       UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
    environment_id UUID NOT NULL REFERENCES app_environment(id) ON DELETE CASCADE,
    app_id         UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    version_id     UUID NOT NULL REFERENCES guide_version(id) ON DELETE CASCADE,
    released_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
    released_by    UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    PRIMARY KEY (guide_id, environment_id)
);
CREATE INDEX idx_guide_release_environment ON guide_release (environment_id);

-- One row per change of what an environment runs: the state it set (a
-- version, or NULL for withdrawn). Reverting marks the latest row reverted
-- and restores the one below it, so repeated reverts walk back step by step.
CREATE TABLE guide_release_event (
    id             BIGSERIAL PRIMARY KEY,
    guide_id       UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
    environment_id UUID NOT NULL REFERENCES app_environment(id) ON DELETE CASCADE,
    app_id         UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    version_id     UUID REFERENCES guide_version(id) ON DELETE CASCADE,
    action         TEXT NOT NULL CHECK (action IN ('release', 'withdraw')),
    actor          UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    occurred_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
    reverted_at    TIMESTAMPTZ,
    reverted_by    UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    CHECK ((action = 'release') = (version_id IS NOT NULL))
);
CREATE INDEX idx_guide_release_event_lookup ON guide_release_event (guide_id, environment_id, id DESC);

-- ------------------------------------------------------------
-- 6. What visitors did
-- ------------------------------------------------------------

-- Analytics, append-only (no session may update an event). Help-center events
-- name no guide; every other event names one. environment_id is NULL only
-- for events of a deleted environment.
CREATE TABLE guide_event (
    id               BIGSERIAL PRIMARY KEY,
    guide_id         UUID REFERENCES guide(id) ON DELETE CASCADE,
    guide_version_id UUID REFERENCES guide_version(id) ON DELETE SET NULL,
    step_id          UUID,
    visitor_id       TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    event_type       guide_event_type NOT NULL,
    occurred_at      TIMESTAMPTZ DEFAULT now() NOT NULL,
    metadata         JSONB DEFAULT '{}' NOT NULL,
    app_id           UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    account_id       TEXT,
    environment_id   UUID REFERENCES app_environment(id) ON DELETE SET NULL,
    CONSTRAINT chk_help_event_has_no_guide CHECK (
        (event_type::text IN ('help_opened', 'help_searched')) = (guide_id IS NULL)
        AND (guide_id IS NOT NULL OR guide_version_id IS NULL)
    )
);
CREATE INDEX idx_event_app_guide ON guide_event (app_id, guide_id, occurred_at DESC);
CREATE INDEX idx_event_app_type ON guide_event (app_id, event_type, occurred_at DESC);
CREATE INDEX idx_event_app_environment ON guide_event (app_id, environment_id, occurred_at DESC);
CREATE INDEX idx_guide_event_occurred_at ON guide_event (occurred_at);

-- What makes an automatic guide show once: per (app, environment, visitor,
-- guide), shown / dismissed / completed and the newest version seen. A later
-- 'shown' never downgrades dismissed or completed at the same version.
CREATE TABLE user_guide_state (
    visitor_id        TEXT NOT NULL,
    guide_id          UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
    status            user_guide_status NOT NULL,
    last_seen_version INTEGER,
    updated_at        TIMESTAMPTZ DEFAULT now() NOT NULL,
    app_id            UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    environment_id    UUID NOT NULL REFERENCES app_environment(id) ON DELETE CASCADE,
    PRIMARY KEY (app_id, environment_id, visitor_id, guide_id)
);

-- ------------------------------------------------------------
-- 7. Operations
-- ------------------------------------------------------------

-- Exceptions the agent caught on customers' pages. Free text: only ever
-- rendered as text.
CREATE TABLE agent_error (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    app_id        UUID NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    message       TEXT NOT NULL,
    stack         TEXT,
    agent_version TEXT,
    url           TEXT,
    occurred_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX idx_agent_error_app_time ON agent_error (app_id, occurred_at DESC);
CREATE INDEX idx_agent_error_occurred_at ON agent_error (occurred_at);

-- Every request a platform admin made under an organization's support access.
CREATE TABLE support_access_log (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    admin_user_id UUID REFERENCES studio_user(id) ON DELETE SET NULL,
    admin_name    TEXT,
    admin_email   TEXT,
    method        TEXT NOT NULL,
    path          TEXT NOT NULL,
    occurred_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX idx_support_access_log_org ON support_access_log (org_id, occurred_at DESC);

-- Unscoped (no RLS): the agent API's shared rate-limit windows
-- (RATE_LIMIT_STORE=postgres), and global settings such as the kill switch.
CREATE TABLE agent_rate_limit (
    bucket       TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count        INTEGER NOT NULL,
    PRIMARY KEY (bucket, window_start)
);

CREATE TABLE system_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- ------------------------------------------------------------
-- 8. active_guide: what the agent may serve.
--
-- One row per guide per environment it is released to: the released version,
-- enabled and inside its date window, with route_match resolved through the
-- saved page when there is one (so editing a page moves live guides with no
-- republish). security_invoker: it runs under the caller's RLS, not the
-- owner's. A release only points at a published version; published_at is
-- checked again as a backstop.
-- ------------------------------------------------------------
CREATE VIEW active_guide WITH (security_invoker = true) AS
SELECT g.id, g.app_id, g.name, g.type,
       gv.id AS version_id, gv.version_number, gv.steps,
       CASE WHEN p.id IS NOT NULL
            THEN jsonb_build_object('type', p.match_type::text, 'value', p.match_value)
            ELSE gv.route_match END AS route_match,
       gv.account_ids,
       gv.start_at, gv.end_at,
       gv.help,
       p.id AS page_id,
       COALESCE(p.start_path, CASE WHEN p.match_type = 'exact' THEN p.match_value END) AS page_start_path,
       gv.activation,
       gv.visitor_tags,
       r.environment_id
FROM guide_release r
JOIN guide g ON g.id = r.guide_id
JOIN guide_version gv ON gv.id = r.version_id AND gv.published_at IS NOT NULL
LEFT JOIN app_page p ON p.id = gv.page_id
WHERE g.enabled = TRUE
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at IS NULL OR gv.end_at >= now());

-- ------------------------------------------------------------
-- 9. Row-level security
--
-- Enabled and FORCED on every scoped table, so even the table owner (the
-- role the backend and migrations run as) is subject to it. Policies of one
-- command are OR-ed. Fine-grained roles (editor vs viewer on content) are
-- checked by the routes; manager-only actions are enforced here too.
-- ------------------------------------------------------------

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
-- Platform admins grant and revoke platform_admin (never their own, checked in code).
CREATE POLICY studio_user_platform_select ON studio_user FOR SELECT USING (app_platform_admin());
CREATE POLICY studio_user_platform_update ON studio_user FOR UPDATE
    USING (app_platform_admin()) WITH CHECK (app_platform_admin());

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
CREATE POLICY organization_owner_delete ON organization FOR DELETE USING (id = ANY(app_owner_org_ids()));
CREATE POLICY organization_platform_select ON organization FOR SELECT USING (app_platform_admin());
CREATE POLICY organization_platform_update ON organization FOR UPDATE
    USING (app_platform_admin()) WITH CHECK (app_platform_admin());
CREATE POLICY organization_platform_delete ON organization FOR DELETE USING (app_platform_admin());

ALTER TABLE org_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_member FORCE ROW LEVEL SECURITY;
CREATE POLICY org_member_select ON org_member FOR SELECT
    USING (user_id = app_current_user_id() OR org_id = ANY(app_org_ids()));
-- Managers add members; the creator becomes owner in the creating transaction
-- (created_at = now() is the same transaction); an invitee joins with exactly
-- the invited role while the invitation is open.
CREATE POLICY org_member_insert ON org_member FOR INSERT WITH CHECK (
    org_id = ANY(app_admin_org_ids())
    OR (user_id = app_current_user_id() AND role = 'owner' AND EXISTS (
        SELECT 1 FROM organization o
        WHERE o.id = org_member.org_id AND o.created_by = app_current_user_id() AND o.created_at = now()))
    OR (user_id = app_current_user_id() AND EXISTS (
        SELECT 1 FROM invitation i
        WHERE i.org_id = org_member.org_id AND i.token_hash = app_invite_token_hash()
          AND i.accepted_at IS NULL AND i.expires_at > now() AND i.org_role = org_member.role))
);
CREATE POLICY org_member_update ON org_member FOR UPDATE
    USING (org_id = ANY(app_admin_org_ids())) WITH CHECK (org_id = ANY(app_admin_org_ids()));
CREATE POLICY org_member_delete ON org_member FOR DELETE
    USING (org_id = ANY(app_admin_org_ids()) OR user_id = app_current_user_id());
CREATE POLICY org_member_platform_select ON org_member FOR SELECT USING (app_platform_admin());

ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_select ON invitation FOR SELECT
    USING (org_id = ANY(app_admin_org_ids()) OR token_hash = app_invite_token_hash());
CREATE POLICY invitation_insert ON invitation FOR INSERT WITH CHECK (org_id = ANY(app_admin_org_ids()));
CREATE POLICY invitation_update ON invitation FOR UPDATE
    USING (org_id = ANY(app_admin_org_ids()) OR token_hash = app_invite_token_hash())
    WITH CHECK (org_id = ANY(app_admin_org_ids()) OR token_hash = app_invite_token_hash());
CREATE POLICY invitation_delete ON invitation FOR DELETE USING (org_id = ANY(app_admin_org_ids()));

ALTER TABLE application ENABLE ROW LEVEL SECURITY;
ALTER TABLE application FORCE ROW LEVEL SECURITY;
CREATE POLICY application_select ON application FOR SELECT USING (
    org_id = ANY(app_org_ids())
    OR id = ANY(app_app_ids())
    OR public_key = app_public_key()
    OR id = app_current_app_id()
    OR org_id IN (SELECT i.org_id FROM invitation i WHERE i.token_hash = app_invite_token_hash())
);
CREATE POLICY application_insert ON application FOR INSERT WITH CHECK (org_id = ANY(app_admin_org_ids()));
-- Editors and up; the key and secret are guarded by application_guard_keys.
CREATE POLICY application_update ON application FOR UPDATE
    USING (id = ANY(app_admin_app_ids())) WITH CHECK (id = ANY(app_admin_app_ids()));
CREATE POLICY application_delete ON application FOR DELETE USING (org_id = ANY(app_admin_org_ids()));
CREATE POLICY application_platform_select ON application FOR SELECT USING (app_platform_admin());
CREATE POLICY application_platform_update ON application FOR UPDATE
    USING (app_platform_admin()) WITH CHECK (app_platform_admin());

ALTER TABLE app_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_member FORCE ROW LEVEL SECURITY;
CREATE POLICY app_member_select ON app_member FOR SELECT USING (
    user_id = app_current_user_id() OR app_id = ANY(app_admin_app_ids()) OR app_id = ANY(app_app_ids())
);
CREATE POLICY app_member_insert ON app_member FOR INSERT WITH CHECK (
    app_id = ANY(app_admin_app_ids())
    OR (user_id = app_current_user_id() AND EXISTS (
        SELECT 1 FROM invitation i JOIN application a ON a.org_id = i.org_id
        WHERE a.id = app_member.app_id AND i.token_hash = app_invite_token_hash()
          AND i.accepted_at IS NULL AND i.expires_at > now()
          AND i.app_roles ->> app_member.app_id::text = app_member.role::text))
);
CREATE POLICY app_member_update ON app_member FOR UPDATE
    USING (app_id = ANY(app_admin_app_ids())) WITH CHECK (app_id = ANY(app_admin_app_ids()));
CREATE POLICY app_member_delete ON app_member FOR DELETE
    USING (app_id = ANY(app_admin_app_ids()) OR user_id = app_current_user_id());

ALTER TABLE app_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_page FORCE ROW LEVEL SECURITY;
CREATE POLICY app_page_studio ON app_page
    USING (app_id = ANY(app_app_ids())) WITH CHECK (app_id = ANY(app_app_ids()));
CREATE POLICY app_page_agent_select ON app_page FOR SELECT USING (app_id = app_current_app_id());

-- Environments own websites (CORS), so writes follow application_update
-- (editor and up), plus managers creating a new app in their organization.
ALTER TABLE app_environment ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_environment FORCE ROW LEVEL SECURITY;
CREATE POLICY app_environment_select ON app_environment FOR SELECT
    USING (app_id = ANY(app_app_ids()) OR app_id = app_current_app_id() OR app_platform_admin() IS TRUE);
CREATE POLICY app_environment_insert ON app_environment FOR INSERT WITH CHECK (
    app_id = ANY(app_admin_app_ids())
    OR EXISTS (SELECT 1 FROM application a WHERE a.id = app_id AND a.org_id = ANY(app_admin_org_ids()))
);
CREATE POLICY app_environment_update ON app_environment FOR UPDATE
    USING (app_id = ANY(app_admin_app_ids())) WITH CHECK (app_id = ANY(app_admin_app_ids()));
CREATE POLICY app_environment_delete ON app_environment FOR DELETE USING (app_id = ANY(app_admin_app_ids()));

ALTER TABLE guide ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide FORCE ROW LEVEL SECURITY;
CREATE POLICY guide_studio ON guide
    USING (app_id = ANY(app_app_ids())) WITH CHECK (app_id = ANY(app_app_ids()));
CREATE POLICY guide_agent_select ON guide FOR SELECT USING (app_id = app_current_app_id());
-- Names and counts for the Administration page; never versions (content).
CREATE POLICY guide_platform_select ON guide FOR SELECT USING (app_platform_admin());

-- No platform policy: a customer's content is readable only under support
-- access, which runs as a viewer of that organization.
ALTER TABLE guide_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_version FORCE ROW LEVEL SECURITY;
CREATE POLICY guide_version_select ON guide_version FOR SELECT USING (EXISTS (
    SELECT 1 FROM guide g
    WHERE g.id = guide_version.guide_id AND (g.app_id = ANY(app_app_ids()) OR g.app_id = app_current_app_id())
));
CREATE POLICY guide_version_insert ON guide_version FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.app_id = ANY(app_app_ids())
));
-- USING sees the row before the update, so publishing a draft (setting
-- published_at) still passes; a published row never matches again.
CREATE POLICY guide_version_update ON guide_version FOR UPDATE
    USING (published_at IS NULL AND EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.app_id = ANY(app_app_ids())))
    WITH CHECK (EXISTS (
        SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.app_id = ANY(app_app_ids())));
CREATE POLICY guide_version_delete ON guide_version FOR DELETE USING (published_at IS NULL AND EXISTS (
    SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.app_id = ANY(app_app_ids())
));

-- Releases are content, like guides: any member's session passes, roles are
-- checked by the routes. The agent reads its own app's releases.
ALTER TABLE guide_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_release FORCE ROW LEVEL SECURITY;
CREATE POLICY guide_release_studio ON guide_release
    USING (app_id = ANY(app_app_ids())) WITH CHECK (app_id = ANY(app_app_ids()));
CREATE POLICY guide_release_agent_select ON guide_release FOR SELECT USING (app_id = app_current_app_id());

-- The release log: read and appended by the Studio; only the revert marks
-- change afterwards, and nothing deletes it.
ALTER TABLE guide_release_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_release_event FORCE ROW LEVEL SECURITY;
CREATE POLICY guide_release_event_select ON guide_release_event FOR SELECT USING (app_id = ANY(app_app_ids()));
CREATE POLICY guide_release_event_insert ON guide_release_event FOR INSERT WITH CHECK (app_id = ANY(app_app_ids()));
CREATE POLICY guide_release_event_update ON guide_release_event FOR UPDATE
    USING (app_id = ANY(app_app_ids())) WITH CHECK (app_id = ANY(app_app_ids()));

-- Written only by the agent; deleted by managers (forget a visitor) and the
-- retention job; never updated.
ALTER TABLE guide_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_event FORCE ROW LEVEL SECURITY;
CREATE POLICY guide_event_agent_insert ON guide_event FOR INSERT WITH CHECK (app_id = app_current_app_id());
CREATE POLICY guide_event_studio_select ON guide_event FOR SELECT USING (app_id = ANY(app_app_ids()));
CREATE POLICY guide_event_platform_select ON guide_event FOR SELECT USING (app_platform_admin());
CREATE POLICY guide_event_manager_delete ON guide_event FOR DELETE USING (app_id = ANY(app_manager_app_ids()));
CREATE POLICY guide_event_retention_select ON guide_event FOR SELECT USING (app_retention());
CREATE POLICY guide_event_retention_delete ON guide_event FOR DELETE USING (app_retention());

ALTER TABLE user_guide_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_guide_state FORCE ROW LEVEL SECURITY;
CREATE POLICY user_guide_state_agent ON user_guide_state
    USING (app_id = app_current_app_id()) WITH CHECK (app_id = app_current_app_id());
CREATE POLICY user_guide_state_manager_select ON user_guide_state FOR SELECT
    USING (app_id = ANY(app_manager_app_ids()));
CREATE POLICY user_guide_state_manager_delete ON user_guide_state FOR DELETE
    USING (app_id = ANY(app_manager_app_ids()));

-- The agent records its own app's errors (and counts them for the hourly cap).
ALTER TABLE agent_error ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_error FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_error_agent_insert ON agent_error FOR INSERT WITH CHECK (app_id = app_current_app_id());
CREATE POLICY agent_error_agent_select ON agent_error FOR SELECT USING (app_id = app_current_app_id());
CREATE POLICY agent_error_studio_select ON agent_error FOR SELECT USING (app_id = ANY(app_app_ids()));
CREATE POLICY agent_error_platform_select ON agent_error FOR SELECT USING (app_platform_admin());
CREATE POLICY agent_error_retention_select ON agent_error FOR SELECT USING (app_retention());
CREATE POLICY agent_error_retention_delete ON agent_error FOR DELETE USING (app_retention());

ALTER TABLE support_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY support_access_log_select ON support_access_log FOR SELECT
    USING (org_id = ANY(app_admin_org_ids()) OR app_platform_admin());
CREATE POLICY support_access_log_insert ON support_access_log FOR INSERT WITH CHECK (app_platform_admin());

-- ------------------------------------------------------------
-- 10. Seed rows
-- ------------------------------------------------------------

-- The global kill switch: 'false' stops every app serving guides.
INSERT INTO system_config (key, value) VALUES ('guide_engine_enabled', 'true');
