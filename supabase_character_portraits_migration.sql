-- =============================================================================
-- Greylander Press — Character Portraits feature
-- Adds: book_characters, character_portraits, plus a Storage bucket reference
--
-- Flow: user uploads a book PDF → AI extracts named characters with descriptions
-- (rows in book_characters) → user clicks a character → AI generates a portrait
-- (row in character_portraits, image stored in Supabase Storage) → user can lock
-- one portrait per character and copy the prompt that produced it.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- book_characters — one row per character extracted from one upload
-- =============================================================================
CREATE TABLE IF NOT EXISTS book_characters (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_signature      TEXT NOT NULL,                -- e.g., the uploaded filename + hash, or user-given title
  book_title          TEXT,                         -- optional human label
  book_style          TEXT,                         -- single style choice for the book ("watercolor", "line art", etc.)
  character_name      TEXT NOT NULL,
  character_description TEXT NOT NULL,              -- pulled from / synthesized from the manuscript
  suggested_prompt    TEXT,                         -- AI-suggested image prompt (user can edit before generating)
  display_order       INT DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, book_signature, character_name)
);

CREATE INDEX IF NOT EXISTS idx_book_characters_user_book
  ON book_characters (user_id, book_signature, display_order);

-- =============================================================================
-- character_portraits — one row per generated image; user locks one per character
-- =============================================================================
CREATE TABLE IF NOT EXISTS character_portraits (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character_id        UUID NOT NULL REFERENCES book_characters(id) ON DELETE CASCADE,
  prompt_used         TEXT NOT NULL,                -- the EXACT prompt sent to the image API (revealed to user when locked)
  image_url           TEXT NOT NULL,                -- public URL in Supabase Storage
  storage_path        TEXT NOT NULL,                -- path inside the bucket (for cleanup)
  model               TEXT,                         -- e.g., "gpt-image-1"
  size                TEXT,                         -- e.g., "1024x1024"
  style               TEXT,                         -- snapshot of the book_style at generation time
  locked              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_character_portraits_character
  ON character_portraits (character_id, locked, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_character_portraits_user_locked
  ON character_portraits (user_id, locked)
  WHERE locked = TRUE;

-- Only one locked portrait per character at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_character_portraits_one_locked
  ON character_portraits (character_id)
  WHERE locked = TRUE;

-- =============================================================================
-- RLS — users can only see / write their own rows
-- =============================================================================
ALTER TABLE book_characters     ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_portraits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS book_chars_own ON book_characters;
CREATE POLICY book_chars_own ON book_characters
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS portraits_own ON character_portraits;
CREATE POLICY portraits_own ON character_portraits
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- Storage bucket — character portraits (public-read, service-role-write)
-- Run this in the Supabase dashboard if the SQL doesn't apply it (bucket creation
-- via SQL is supported in modern Supabase, but the dashboard is more reliable):
--   Storage → New bucket → name "character-portraits", public: yes, no file size cap
-- =============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('character-portraits', 'character-portraits', true)
ON CONFLICT (id) DO NOTHING;

-- Bucket policies: any authenticated user can read; service-role writes
DROP POLICY IF EXISTS "portraits public read" ON storage.objects;
CREATE POLICY "portraits public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'character-portraits');

DROP POLICY IF EXISTS "portraits user delete own" ON storage.objects;
CREATE POLICY "portraits user delete own" ON storage.objects
  FOR DELETE USING (bucket_id = 'character-portraits' AND auth.uid()::text = (storage.foldername(name))[1]);
