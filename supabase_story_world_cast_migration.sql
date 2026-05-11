-- =============================================================================
-- Greylander Press — Story World Cast
-- Adds: story_world_cast — book-level character references that lock likeness
-- across every page of an illustrated book. Each cast member has an original
-- uploaded photo plus a restyled version in the book's art style; the restyled
-- image is passed to gpt-image-1's edits endpoint as a reference whenever a
-- page is generated, so Charlotte stays Charlotte across all 8 pages.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS story_world_cast (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  book_id                 UUID NOT NULL REFERENCES story_worlds(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  description             TEXT,
  source_storage_path     TEXT,
  reference_storage_path  TEXT,
  reference_url           TEXT,
  display_order           INT NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (book_id, name)
);

CREATE INDEX IF NOT EXISTS idx_story_world_cast_book
  ON story_world_cast (book_id, display_order);

ALTER TABLE story_world_cast ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS story_world_cast_own ON story_world_cast;
CREATE POLICY story_world_cast_own ON story_world_cast
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
