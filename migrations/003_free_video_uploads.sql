CREATE TABLE free_video_media (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size > 0 AND file_size <= 26214400),
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'video/mp4' CHECK (content_type = 'video/mp4'),
  media_data BYTEA NOT NULL,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE free_videos ADD COLUMN media_id TEXT REFERENCES free_video_media(id);
CREATE UNIQUE INDEX idx_free_videos_media_id ON free_videos(media_id) WHERE media_id IS NOT NULL;
