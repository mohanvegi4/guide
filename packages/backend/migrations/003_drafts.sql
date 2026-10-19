-- ============================================================
-- Drafts: an unpublished guide_version row (published_at IS NULL).
--
-- Drafts let authors save work-in-progress and preview it (signed preview
-- links) before anything goes live. A draft is never referenced by
-- guide.current_version_id, so it can't reach /guides/active.
-- ============================================================

-- At most one working draft per guide; saving again updates it in place.
CREATE UNIQUE INDEX uq_guide_version_one_draft ON guide_version (guide_id) WHERE published_at IS NULL;

-- Published versions are immutable — enforce it in the database, not just in
-- the routes. Only draft rows may be updated (USING sees the pre-update row,
-- so promoting a draft by setting published_at is still allowed), and
-- published rows can't be deleted either; history must survive rollbacks.
DROP POLICY guide_version_update ON guide_version;
CREATE POLICY guide_version_update ON guide_version FOR UPDATE
    USING (
        published_at IS NULL
        AND EXISTS (SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.tenant_id = app_current_tenant_id())
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.tenant_id = app_current_tenant_id())
    );

DROP POLICY guide_version_delete ON guide_version;
CREATE POLICY guide_version_delete ON guide_version FOR DELETE
    USING (
        published_at IS NULL
        AND EXISTS (SELECT 1 FROM guide g WHERE g.id = guide_version.guide_id AND g.tenant_id = app_current_tenant_id())
    );
