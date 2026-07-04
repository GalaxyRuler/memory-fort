# Phase 5 Vector Contract

Status: Task -1 policy/API/asset contract for Phase 5. This document is the
contract that must be satisfied before any vector schema, migration, backfill, or
cutover work is allowed.

## Scope And Stop Rules

Phase 5 adds a local vector signal to the existing lexical index. This contract
does not authorize a schema migration or a cutover by itself.

Hard invariants:

- Lexical search stays available first. Embedding and vector backfill may lag,
  fail, or be disabled without blocking the lexical index.
- Hosted-only vectors do not authorize the cutover. The default user path must
  work locally, offline, and without a hosted embedding key.
- Task 0 must prove packaged ONNX loading, sqlite-vec scale, contention,
  latency, memory, and disk bars before Task 1 schema work starts.
- No code should bake embedding into the lexical reconcile critical path.
- No code should hardcode inline vector search without the SearchExecutor seam.

## Embedder Policy

Default embedder:

- Provider: local.
- Runtime: `onnxruntime-node`.
- Model target: `BAAI/bge-small-en-v1.5`.
- Dimension: 384.
- Asset strategy: bundled with the app for offline default behavior.
- Remote model loading: disabled in packaged probes and production use.

Hosted quality tier:

- Hosted Voyage remains an explicit opt-in tier behind the existing
  `EmbedClient` factory.
- The UI or settings flow must disclose: chunk text leaves the machine; Voyage
  may retain or train on submitted data unless the user has configured an
  eligible zero-retention arrangement with the provider.
- Hosted vectors can improve a user-selected quality tier, but they cannot be
  the only vector path used to authorize the default cutover.

The first implementation may bake off `bge-small-en-v1.5` against `gte-small`
and `arctic-embed-xs` only inside Task 0 measurement. If `bge-small-en-v1.5`
misses the Task 0 bars, Phase 5 stops or rescopes before schema work.

## Reader API Shapes

The dashboard/search API must expose vector readiness separately from lexical
readiness.

```ts
export type VectorState =
  | "disabled"
  | "unavailable"
  | "model-loading"
  | "backfilling"
  | "partial"
  | "ready"
  | "failed";

export interface VectorCoverage {
  embeddedEligible: number;
  totalEligible: number;
}

export type HybridMode =
  | "lexical-only"
  | "lexical-plus-vector"
  | "vector-disabled-by-policy";
```

Semantics:

- `disabled`: vectors are off by policy or user setting.
- `unavailable`: required native/model assets are missing or unsupported.
- `model-loading`: local model load is in progress.
- `backfilling`: lexical index is usable; vectors are being computed.
- `partial`: some eligible chunks have vectors, but coverage is below the
  configured hybrid threshold.
- `ready`: vector coverage and runtime availability permit hybrid search.
- `failed`: vector runtime/backfill hit a typed failure; lexical search remains
  usable.

`hybridMode` is a per-response execution mode, not a product success marker.
`lexical-only` is an operational degrade path; it does not prove the cutover is
acceptable.

## SearchExecutor Seam

Vector search must be isolated behind this seam before Task 1 production code:

```ts
export interface SearchExecutor {
  search(req: SearchRequest): Promise<SearchResponse>;
}
```

Required implementations:

- `InlineSearchExecutor`: runs query embedding and sqlite-vec KNN in the
  dashboard-service process. This ships only if Task 0C proves event-loop lag,
  non-search API latency, memory, and search latency stay within bars.
- `UtilityProcessSearchExecutor`: runs query embedding and sqlite-vec KNN in a
  dedicated read/search utilityProcess. This is the fallback if inline KNN or
  duplicate ONNX loads block the dashboard event loop.

The selected executor is a runtime/process-placement decision from Task 0C, not
a schema decision. No worker_thread implementation is in scope.

## Embedding Profile Fingerprint

Every persisted vector is keyed by profile and exact payload identity:

```ts
export interface EmbeddingProfileFingerprint {
  provider: string;
  runtime: string;
  runtimeVersion: string;
  modelId: string;
  modelRevision: string;
  modelFileSha256: string;
  tokenizerHash: string;
  pooling: "mean" | "cls" | string;
  normalization: "l2" | "none" | string;
  dtype: "float32" | "int8" | "binary";
  dimension: number;
  prefixStrategy: "none" | "query-passage" | string;
  chunkerVersion: string;
  payloadRecipe: string;
  maxTokenPolicy: string;
}
```

Reuse key:

```ts
profileId + embeddedPayloadHash
```

`embeddedPayloadHash` is the hash of the exact payload sent to the embedder. It
is not interchangeable with `textHash`. The payload hash must change when any
embedded text recipe input changes, including heading/path/frontmatter prefix,
chunk body normalization, query/passage prefixing, or max-token truncation.

Profile changes rebuild vectors for that profile. They must not require a full
lexical database rebuild.

## Model Asset Manifest Contract

The bundled model lives under:

```text
assets/embedding-models/bge-small-en-v1.5/
```

Task 0A may adjust the directory only if the packaged app still resolves assets
from `resources/app` and the manifest remains colocated with the bytes.

Required manifest file:

```text
assets/embedding-models/bge-small-en-v1.5/manifest.json
```

Manifest shape:

```json
{
  "schemaVersion": 1,
  "modelId": "BAAI/bge-small-en-v1.5",
  "modelRevision": "5c38ec7",
  "license": "mit",
  "dimension": 384,
  "maxTokens": 512,
  "pooling": "cls",
  "normalization": "l2",
  "dtype": "float32",
  "source": "https://huggingface.co/BAAI/bge-small-en-v1.5",
  "assets": [
    {
      "path": "onnx/model.onnx",
      "size": 133093490,
      "sha256": "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35"
    },
    {
      "path": "tokenizer.json",
      "size": 711396,
      "sha256": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"
    },
    {
      "path": "tokenizer_config.json",
      "size": 366,
      "sha256": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3"
    },
    {
      "path": "special_tokens_map.json",
      "size": 125,
      "sha256": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3"
    },
    {
      "path": "config.json",
      "size": 743,
      "sha256": "094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750"
    },
    {
      "path": "sentence_bert_config.json",
      "size": 52,
      "sha256": "84e39fda68ccbff05bfa723ae9c0e70e23e2ec373b76e0f8c6e71af72a693cbf"
    },
    {
      "path": "1_Pooling/config.json",
      "size": 190,
      "sha256": "d1caf60c96f5fba2157c0c26b76d80818fad6cf0b8eb5e73ec372ff9818eba5c"
    },
    {
      "path": "vocab.txt",
      "size": 231508,
      "sha256": "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3"
    },
    {
      "path": "LICENSE",
      "size": 1065,
      "sha256": "587a673933425dbc36ec61268d3b954051b2d3ef3c9b322ede357976055ffdd5"
    }
  ]
}
```

The ONNX size and SHA-256 above are source metadata from the Hugging Face LFS
object. Non-LFS asset SHA-256 values are computed from the vendored bytes.
The MIT notice for the redistributed BGE assets must stay next to the weights
and must be included in the manifest. `LICENSE-NOTICE.md` must also identify the
retained BGE notice and the retained `onnxruntime-node` / ONNX Runtime MIT
notice before packaged evidence is accepted.

Update policy:

- Model updates require changing `modelRevision`, all asset hashes, and the
  embedding profile fingerprint.
- A profile/hash change clears or rebuilds vectors for that profile only.
- Missing, corrupt, or hash-mismatched local assets set `vectorState` to
  `unavailable` or `failed` and keep lexical search online.
- No first-run model download may occur for the default path.

Bundle decision:

- Decision: bundle the model and tokenizer assets.
- Reason: the default vector path must be offline-capable and keyless; a
  first-run download would make vectors non-default for offline users.
- Tradeoffs accepted for Task 0 measurement: larger unsigned installer, slower
  download/update, and possible antivirus scrutiny on a larger native/model
  payload.
- Expected installer-size delta to disclose in evidence: about 128 MiB for the
  BGE ONNX model plus the platform-specific ONNX Runtime native payload copied
  by `electron-builder`.

`electron-builder.yml` must include both `node_modules/onnxruntime-node/**` and
the bundled model asset directory once Task 0A vendors the runtime and model
bytes. This mirrors the existing better-sqlite3/sqlite-vec allowlist pattern
under `asar: false`.

## Lexical-First / Vector-Later Lifecycle

The lexical generation and vector generation are independent.

Fast lexical reconcile:

- Reads files.
- Chunks markdown.
- Writes file/chunk/FTS rows in short transactions.
- Advances lexical generation.
- Serves lexical search immediately.

Vector backfill:

- Reads committed chunk rows that need vectors.
- Builds the exact embedded payload.
- Computes `embeddedPayloadHash`.
- Embeds outside any write transaction in bounded batches.
- Rechecks `chunkRowid + profileId + embeddedPayloadHash` before committing.
- Writes/upserts vectors in short transactions.
- Advances vector generation and coverage.

Shutdown or vector failure cannot corrupt or block the lexical index. Stale
chunks must skip vector writes rather than reviving old payloads.

## Pre-Task-1 Acceptance

Before Task 1 begins, the repo must have:

- This contract committed.
- Task 0A/0B/0C evidence with measured D1, D2, and D5 decisions.
- A go/no-go decision that explicitly says whether Phase 5 continues.
- If continuing, a confirmed SearchExecutor placement and vector dtype.
- If stopped, an evidence-backed rescope note instead of a schema migration.
