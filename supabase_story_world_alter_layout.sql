-- =============================================================================
-- Greylander Press — Story World layout columns
-- Adds page-layout choices to story_worlds: page size, font, text size, alignment.
-- Safe to re-run.
-- =============================================================================

ALTER TABLE story_worlds ADD COLUMN IF NOT EXISTS page_size  TEXT NOT NULL DEFAULT 'letter';
ALTER TABLE story_worlds ADD COLUMN IF NOT EXISTS text_font  TEXT NOT NULL DEFAULT 'times';
ALTER TABLE story_worlds ADD COLUMN IF NOT EXISTS text_size  TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE story_worlds ADD COLUMN IF NOT EXISTS text_align TEXT NOT NULL DEFAULT 'left';
