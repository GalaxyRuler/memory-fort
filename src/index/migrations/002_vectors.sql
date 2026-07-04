CREATE TABLE IF NOT EXISTS embedding_profiles (
  profileId TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  runtime TEXT NOT NULL,
  runtimeVersion TEXT NOT NULL,
  modelId TEXT NOT NULL,
  modelRevision TEXT NOT NULL,
  modelHash TEXT NOT NULL,
  tokenizerHash TEXT NOT NULL,
  pooling TEXT NOT NULL,
  normalization TEXT NOT NULL,
  dtype TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK(dimension = 384),
  prefixStrategy TEXT NOT NULL,
  chunkerVersion TEXT NOT NULL,
  payloadRecipe TEXT NOT NULL,
  maxTokenPolicy TEXT NOT NULL,
  fingerprintJson TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunkRowid INTEGER NOT NULL REFERENCES chunks(rowid) ON DELETE CASCADE,
  profileId TEXT NOT NULL REFERENCES embedding_profiles(profileId) ON DELETE CASCADE,
  coarseRowid INTEGER NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'embedded', 'failed', 'skipped')),
  embeddedPayloadHash TEXT,
  failureReason TEXT,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY(chunkRowid, profileId)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors_bin USING vec0(embedding bit[384]);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors_i8 USING vec0(embedding int8[384]);

CREATE TABLE IF NOT EXISTS vector_coverage (
  profileId TEXT PRIMARY KEY REFERENCES embedding_profiles(profileId) ON DELETE CASCADE,
  eligible INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunk_vectors_profile_status ON chunk_vectors(profileId, status);
CREATE INDEX IF NOT EXISTS idx_chunk_vectors_coarseRowid ON chunk_vectors(coarseRowid);
