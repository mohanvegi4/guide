-- ============================================================
-- In-App Guide Engine — Postgres Schema (multi-tenant)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ------------------------------------------------------------
-- Tenants
-- ------------------------------------------------------------
CREATE TABLE tenant (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- System / tenant level kill switches
-- ------------------------------------------------------------
CREATE TABLE system_config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_config (key, value) VALUES ('guide_engine_enabled', 'true');

CREATE TABLE tenant_config (
    tenant_id   UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, key)
);

-- ------------------------------------------------------------
-- Guides
-- ------------------------------------------------------------
CREATE TYPE guide_type AS ENUM ('tooltip', 'modal', 'banner', 'tour', 'checklist', 'survey', 'beacon');
CREATE TYPE guide_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE guide (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- tenant scoping: either owned by a tenant, or global (tenant_id NULL + is_global TRUE)
    tenant_id           UUID REFERENCES tenant(id) ON DELETE CASCADE,
    is_global           BOOLEAN NOT NULL DEFAULT FALSE,

    name                TEXT NOT NULL,
    type                guide_type NOT NULL,
    status              guide_status NOT NULL DEFAULT 'draft',
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,   -- the primary admin on/off switch

    current_version_id  UUID,  -- FK added after guide_version exists (see ALTER below)

    created_by          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_tenant_or_global CHECK (
        (is_global = TRUE  AND tenant_id IS NULL) OR
        (is_global = FALSE AND tenant_id IS NOT NULL)
    )
);

CREATE INDEX idx_guide_tenant ON guide (tenant_id);
CREATE INDEX idx_guide_enabled ON guide (enabled) WHERE enabled = TRUE;

-- ------------------------------------------------------------
-- Guide versions (immutable once published)
-- ------------------------------------------------------------
CREATE TABLE guide_version (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guide_id        UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,

    steps           JSONB NOT NULL DEFAULT '[]',   -- array of step objects (see step table note below)
    route_match     JSONB NOT NULL DEFAULT '{}',   -- e.g. {"type": "exact"|"pattern", "value": "/dashboard/*"}

    start_at        TIMESTAMPTZ,
    end_at          TIMESTAMPTZ,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (guide_id, version_number)
);

CREATE INDEX idx_guide_version_guide ON guide_version (guide_id);

ALTER TABLE guide
    ADD CONSTRAINT fk_guide_current_version
    FOREIGN KEY (current_version_id) REFERENCES guide_version(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- Steps
-- NOTE: modeled here as JSONB inside guide_version.steps for simplicity (fewer joins,
-- easy to version atomically). A normalized `step` table is included below as an
-- alternative if you'd rather query/filter steps directly in SQL.
-- ------------------------------------------------------------
CREATE TABLE step (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guide_version_id    UUID NOT NULL REFERENCES guide_version(id) ON DELETE CASCADE,
    step_order          INTEGER NOT NULL,
    type                guide_type NOT NULL,
    target_selector     TEXT,                 -- e.g. '[data-guide-id="invite-button"]'
    content             TEXT NOT NULL,        -- sanitized HTML/rich text
    position            TEXT,                  -- e.g. 'top' | 'bottom' | 'left' | 'right' | 'center'
    actions             JSONB NOT NULL DEFAULT '[]', -- e.g. [{"label":"Next","action":"next"}]

    UNIQUE (guide_version_id, step_order)
);

CREATE INDEX idx_step_guide_version ON step (guide_version_id);

-- ------------------------------------------------------------
-- Events (analytics, self-contained — no external pipeline)
-- ------------------------------------------------------------
CREATE TYPE guide_event_type AS ENUM (
    'guide_shown', 'guide_step_viewed', 'guide_step_completed',
    'guide_dismissed', 'guide_completed', 'guide_error', 'survey_response'
);

CREATE TABLE guide_event (
    id                  BIGSERIAL PRIMARY KEY,   -- BIGSERIAL: high write volume, no need for UUID here
    tenant_id           UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    guide_id            UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
    guide_version_id    UUID REFERENCES guide_version(id) ON DELETE SET NULL,
    step_id             UUID REFERENCES step(id) ON DELETE SET NULL,

    user_id             TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    event_type          guide_event_type NOT NULL,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata            JSONB NOT NULL DEFAULT '{}'
);

-- tenant_id first in every composite index: nearly all queries filter by tenant first
CREATE INDEX idx_event_tenant_guide ON guide_event (tenant_id, guide_id, occurred_at DESC);
CREATE INDEX idx_event_tenant_type  ON guide_event (tenant_id, event_type, occurred_at DESC);

-- ------------------------------------------------------------
-- Per-user guide state (dismissal / completion tracking)
-- ------------------------------------------------------------
CREATE TYPE user_guide_status AS ENUM ('dismissed', 'completed', 'snoozed');

CREATE TABLE user_guide_state (
    tenant_id           UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL,
    guide_id            UUID NOT NULL REFERENCES guide(id) ON DELETE CASCADE,

    status              user_guide_status NOT NULL,
    last_seen_version   INTEGER,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, user_id, guide_id)
);

CREATE INDEX idx_user_guide_state_tenant_user ON user_guide_state (tenant_id, user_id);

-- ------------------------------------------------------------
-- Row-Level Security (defense in depth on top of app-level scoping)
-- App connects with a role that sets `app.current_tenant_id` per request/session,
-- e.g.: SET LOCAL app.current_tenant_id = '3fa85f64-...';
-- ------------------------------------------------------------
ALTER TABLE guide ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_guide_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY guide_tenant_isolation ON guide
    USING (
        is_global = TRUE
        OR tenant_id = current_setting('app.current_tenant_id', true)::UUID
    );

CREATE POLICY guide_event_tenant_isolation ON guide_event
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

CREATE POLICY user_guide_state_tenant_isolation ON user_guide_state
    USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- ------------------------------------------------------------
-- Helper view: "active guides" a client would fetch from /guides/active
-- (application still filters by route_match + enabled in code, since route
-- pattern matching is easier to express in the app layer than in SQL)
-- ------------------------------------------------------------
CREATE VIEW active_guide AS
SELECT g.id, g.tenant_id, g.is_global, g.name, g.type,
       gv.id AS version_id, gv.steps, gv.route_match, gv.start_at, gv.end_at
FROM guide g
JOIN guide_version gv ON gv.id = g.current_version_id
WHERE g.enabled = TRUE
  AND g.status = 'published'
  AND (gv.start_at IS NULL OR gv.start_at <= now())
  AND (gv.end_at IS NULL OR gv.end_at >= now());
