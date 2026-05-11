-- =============================================================================
-- Greylander Press — Story World
-- Adds: story_worlds, story_world_pages, plus a Storage bucket reference
--
-- Flow: user creates a Story World (title + style + mode + N pages) →
-- Claude suggests an image prompt for each page → user generates art (or uploads
-- their own crayon drawing) → download a single-page PDF or the full book.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- story_worlds — one row per book/story
-- =============================================================================
CREATE TABLE IF NOT EXISTS story_worlds (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  style       TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'story',  -- 'story' | 'wordless' | 'comic' | 'picture'
  page_count  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_story_worlds_user
  ON story_worlds (user_id, created_at DESC);

-- =============================================================================
-- story_world_pages — one row per page in a story (in display order)
-- =============================================================================
CREATE TABLE IF NOT EXISTS story_world_pages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  book_id           UUID NOT NULL REFERENCES story_worlds(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_order        INT NOT NULL,
  page_text         TEXT NOT NULL DEFAULT '',
  suggested_prompt  TEXT,
  prompt_used       TEXT,
  image_url         TEXT,
  storage_path      TEXT,
  user_uploaded     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (book_id, page_order)
);

CREATE INDEX IF NOT EXISTS idx_story_world_pages_book
  ON story_world_pages (book_id, page_order);

-- =============================================================================
-- RLS — users can only see / write their own rows
-- =============================================================================
ALTER TABLE story_worlds      ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_world_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS story_worlds_own ON story_worlds;
CREATE POLICY story_worlds_own ON story_worlds
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS story_world_pages_own ON story_world_pages;
CREATE POLICY story_world_pages_own ON story_world_pages
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- Storage bucket — Story World art (public-read, service-role-write)
-- =============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('story-worlds', 'story-worlds', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "story world public read" ON storage.objects;
CREATE POLICY "story world public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'story-worlds');

DROP POLICY IF EXISTS "story world user delete own" ON storage.objects;
CREATE POLICY "story world user delete own" ON storage.objects
  FOR DELETE USING (bucket_id = 'story-worlds' AND auth.uid()::text = (storage.foldername(name))[1]);
