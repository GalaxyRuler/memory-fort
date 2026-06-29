CREATE TABLE IF NOT EXISTS files (
  relPath TEXT PRIMARY KEY,
  kind TEXT,
  sizeBytes INTEGER,
  mtimeMs INTEGER,
  contentHash TEXT,
  generation INTEGER,
  lastSeenRunId INTEGER,
  errorState TEXT,
  indexedAt INTEGER,
  lastErrorAt INTEGER
);

CREATE TABLE IF NOT EXISTS chunks (
  rowid INTEGER PRIMARY KEY,
  chunkId TEXT UNIQUE NOT NULL,
  relPath TEXT NOT NULL REFERENCES files(relPath) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  headingPath TEXT,
  byteStart INTEGER NOT NULL,
  byteEnd INTEGER NOT NULL,
  text TEXT NOT NULL,
  textHash TEXT NOT NULL,
  generation INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  headingPath,
  relPath UNINDEXED,
  content='chunks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, headingPath, relPath)
  VALUES (new.rowid, new.text, new.headingPath, new.relPath);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, headingPath, relPath)
  VALUES ('delete', old.rowid, old.text, old.headingPath, old.relPath);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, headingPath, relPath)
  VALUES ('delete', old.rowid, old.text, old.headingPath, old.relPath);
  INSERT INTO chunks_fts(rowid, text, headingPath, relPath)
  VALUES (new.rowid, new.text, new.headingPath, new.relPath);
END;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT INTO meta(key, value) VALUES ('tokenizer', 'unicode61 remove_diacritics 2')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

CREATE INDEX IF NOT EXISTS idx_chunks_relPath ON chunks(relPath);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_relPath_ordinal ON chunks(relPath, ordinal);
CREATE INDEX IF NOT EXISTS idx_chunks_generation ON chunks(generation);
CREATE INDEX IF NOT EXISTS idx_files_generation ON files(generation);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(contentHash);
