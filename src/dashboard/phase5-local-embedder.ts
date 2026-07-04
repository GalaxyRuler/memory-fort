import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import * as ort from "onnxruntime-node";

export interface Phase5ModelAsset {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface Phase5ModelManifest {
  readonly schemaVersion: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly license: string;
  readonly dimension: number;
  readonly maxTokens: number;
  readonly pooling: "cls";
  readonly normalization: "l2";
  readonly dtype: "float32";
  readonly source: string;
  readonly assets: readonly Phase5ModelAsset[];
}

export interface Phase5LocalEmbedder {
  readonly modelRoot: string;
  readonly manifest: Phase5ModelManifest;
  readonly loadTimeMs: number;
  readonly intraOpNumThreads: number;
  readonly interOpNumThreads: number;
  embed(texts: readonly string[]): Promise<Phase5EmbeddingBatch>;
}

export interface Phase5EmbeddingBatch {
  readonly vectors: number[][];
  readonly dim: number;
  readonly inputTokens: number;
  readonly elapsedMs: number;
}

export interface Phase5EmbedProbeResult {
  readonly modelRoot: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly dimension: number;
  readonly intraOpNumThreads: number;
  readonly interOpNumThreads: number;
  readonly loadTimeMs: number;
  readonly docsPerSecond: number;
  readonly tokensPerSecond: number;
  readonly queryP50Ms: number;
  readonly queryP95Ms: number;
  readonly rssBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
  readonly runtimeNativeFiles: readonly Phase5NativeFile[];
}

export interface Phase5NativeFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface TokenizedText {
  readonly ids: readonly number[];
  readonly attentionMask: readonly number[];
  readonly tokenTypeIds: readonly number[];
}

const require = createRequire(import.meta.url);
const MODEL_RELATIVE_ROOT = join("assets", "embedding-models", "bge-small-en-v1.5");
const MANIFEST_FILE = "manifest.json";
const VOCAB_FILE = "vocab.txt";
const MODEL_FILE = join("onnx", "model.onnx");
const CLS_TOKEN = "[CLS]";
const SEP_TOKEN = "[SEP]";
const PAD_TOKEN = "[PAD]";
const UNK_TOKEN = "[UNK]";
const MAX_WORDPIECE_CHARS = 100;

export async function createPhase5LocalEmbedder(opts: {
  readonly modelRoot?: string;
  readonly intraOpNumThreads?: number;
  readonly interOpNumThreads?: number;
} = {}): Promise<Phase5LocalEmbedder> {
  const modelRoot = opts.modelRoot ?? resolvePhase5ModelRoot();
  const manifest = validatePhase5ModelAssets(modelRoot);
  const vocab = loadVocab(join(modelRoot, VOCAB_FILE));
  const started = performance.now();
  const intraOpNumThreads = opts.intraOpNumThreads ?? readPositiveEnvInt("MEMORY_PHASE5_ONNX_INTRA_OP_THREADS", 2);
  const interOpNumThreads = opts.interOpNumThreads ?? readPositiveEnvInt("MEMORY_PHASE5_ONNX_INTER_OP_THREADS", 1);
  const session = await ort.InferenceSession.create(join(modelRoot, MODEL_FILE), {
    executionProviders: ["cpu"],
    intraOpNumThreads,
    interOpNumThreads,
  });
  const loadTimeMs = performance.now() - started;

  assertModelSignature(session);

  return {
    modelRoot,
    manifest,
    loadTimeMs,
    intraOpNumThreads,
    interOpNumThreads,
    embed: async (texts) => embedTexts(session, vocab, manifest, texts),
  };
}

export function resolvePhase5ModelRoot(): string {
  const envRoot = process.env["MEMORY_PHASE5_MODEL_ROOT"];
  if (envRoot?.trim()) {
    const resolved = resolve(envRoot);
    if (!isAbsolute(resolved)) throw new Error(`MEMORY_PHASE5_MODEL_ROOT is not absolute: ${envRoot}`);
    return resolved;
  }

  const appPath = process.env["MEMORY_FORT_APP_PATH"];
  if (appPath && isAbsolute(appPath)) return join(appPath, MODEL_RELATIVE_ROOT);

  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  if (resourcesPath && isAbsolute(resourcesPath)) return join(resourcesPath, "app", MODEL_RELATIVE_ROOT);

  return resolve(process.cwd(), MODEL_RELATIVE_ROOT);
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec";
const LFS_POINTER_MAX_BYTES = 1024;

/**
 * True when the bundled model file is a Git LFS pointer stub instead of the
 * real weights (a checkout without `lfs: true`). Missing files return false so
 * genuine packaging failures still hard-fail validation.
 */
export function isPhase5ModelLfsPointer(modelRoot = resolvePhase5ModelRoot()): boolean {
  const modelPath = join(modelRoot, "onnx", "model.onnx");
  if (!existsSync(modelPath)) return false;
  const size = statSync(modelPath).size;
  if (size > LFS_POINTER_MAX_BYTES) return false;
  return readFileSync(modelPath, "utf8").startsWith(LFS_POINTER_PREFIX);
}

export function validatePhase5ModelAssets(modelRoot = resolvePhase5ModelRoot()): Phase5ModelManifest {
  const manifestPath = join(modelRoot, MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Phase5ModelManifest;
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported model manifest schema: ${manifest.schemaVersion}`);
  if (manifest.modelId !== "BAAI/bge-small-en-v1.5") throw new Error(`unexpected model id: ${manifest.modelId}`);
  if (manifest.dimension !== 384) throw new Error(`unexpected model dimension: ${manifest.dimension}`);
  if (manifest.pooling !== "cls") throw new Error(`unexpected pooling mode: ${String(manifest.pooling)}`);
  if (manifest.normalization !== "l2") throw new Error(`unexpected normalization: ${String(manifest.normalization)}`);

  for (const asset of manifest.assets) {
    const assetPath = join(modelRoot, asset.path);
    assertInside(modelRoot, assetPath, asset.path);
    if (!existsSync(assetPath)) throw new Error(`missing phase5 model asset: ${asset.path}`);
    const info = statSync(assetPath);
    if (info.size !== asset.size) {
      throw new Error(`phase5 model asset size mismatch for ${asset.path}: expected ${asset.size} got ${info.size}`);
    }
    const actualSha256 = sha256File(assetPath);
    if (actualSha256 !== asset.sha256) {
      throw new Error(
        `phase5 model asset sha256 mismatch for ${asset.path}: expected ${asset.sha256} got ${actualSha256}`,
      );
    }
  }
  return manifest;
}

export async function runPhase5EmbedProbe(opts: {
  readonly modelRoot?: string;
  readonly documents?: readonly string[];
  readonly queries?: readonly string[];
  readonly intraOpNumThreads?: number;
  readonly interOpNumThreads?: number;
} = {}): Promise<Phase5EmbedProbeResult> {
  const documents = opts.documents ?? [
    "Memory Fort validates local vector search without sending chunks to a hosted embedding service.",
    "The dashboard must stay responsive while the writer embeds committed chunks in the background.",
    "sqlite-vec exact nearest-neighbour search is measured before any schema migration is allowed.",
  ];
  const queries = opts.queries ?? [
    "local vector search",
    "dashboard responsiveness",
    "sqlite vec nearest neighbour",
    "offline bundled embedding model",
  ];
  const embedder = await createPhase5LocalEmbedder(opts);
  const docBatch = await embedder.embed(documents);
  const queryTimes: number[] = [];
  for (const query of queries) {
    const started = performance.now();
    const batch = await embedder.embed([query]);
    if (batch.vectors.length !== 1 || batch.vectors[0]?.length !== embedder.manifest.dimension) {
      throw new Error(`query embed returned invalid vector shape for ${JSON.stringify(query)}`);
    }
    queryTimes.push(performance.now() - started);
  }
  const memory = process.memoryUsage();
  return {
    modelRoot: embedder.modelRoot,
    modelId: embedder.manifest.modelId,
    modelRevision: embedder.manifest.modelRevision,
    dimension: embedder.manifest.dimension,
    intraOpNumThreads: embedder.intraOpNumThreads,
    interOpNumThreads: embedder.interOpNumThreads,
    loadTimeMs: embedder.loadTimeMs,
    docsPerSecond: documents.length / Math.max(docBatch.elapsedMs / 1000, 0.001),
    tokensPerSecond: docBatch.inputTokens / Math.max(docBatch.elapsedMs / 1000, 0.001),
    queryP50Ms: percentile(queryTimes, 50),
    queryP95Ms: percentile(queryTimes, 95),
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    runtimeNativeFiles: getPhase5OnnxRuntimeNativeFiles(),
  };
}

export function getPhase5OnnxRuntimeNativeFiles(): Phase5NativeFile[] {
  const packageRoot = dirname(require.resolve("onnxruntime-node/package.json"));
  const nativeDir = join(packageRoot, "bin", "napi-v6", process.platform, process.arch);
  if (!existsSync(nativeDir)) {
    throw new Error(`onnxruntime-node native directory missing for ${process.platform}-${process.arch}: ${nativeDir}`);
  }
  return ["onnxruntime_binding.node", ...platformSidecars()]
    .map((file) => join(nativeDir, file))
    .filter((path) => existsSync(path))
    .map((path) => {
      const info = statSync(path);
      return { path, size: info.size, sha256: sha256File(path) };
    });
}

async function embedTexts(
  session: ort.InferenceSession,
  vocab: ReadonlyMap<string, number>,
  manifest: Phase5ModelManifest,
  texts: readonly string[],
): Promise<Phase5EmbeddingBatch> {
  if (texts.length === 0) return { vectors: [], dim: manifest.dimension, inputTokens: 0, elapsedMs: 0 };
  const started = performance.now();
  const tokenized = texts.map((text) => tokenizeText(text, vocab, manifest.maxTokens));
  const seqLen = Math.max(...tokenized.map((entry) => entry.ids.length));
  const inputIds = toInt64TensorData(tokenized, seqLen, "ids");
  const attentionMask = toInt64TensorData(tokenized, seqLen, "attentionMask");
  const tokenTypeIds = toInt64TensorData(tokenized, seqLen, "tokenTypeIds");
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", inputIds, [texts.length, seqLen]),
    attention_mask: new ort.Tensor("int64", attentionMask, [texts.length, seqLen]),
    token_type_ids: new ort.Tensor("int64", tokenTypeIds, [texts.length, seqLen]),
  };
  const output = await session.run(feeds);
  const hidden = output["last_hidden_state"];
  if (!(hidden instanceof ort.Tensor)) throw new Error("ONNX output last_hidden_state is not a tensor");
  if (!Array.isArray(hidden.dims) || hidden.dims.length !== 3) {
    throw new Error(`unexpected last_hidden_state dims: ${JSON.stringify(hidden.dims)}`);
  }
  const [batch, sequence, dim] = hidden.dims;
  if (batch !== texts.length || sequence !== seqLen || dim !== manifest.dimension) {
    throw new Error(
      `unexpected last_hidden_state shape: ${JSON.stringify(hidden.dims)} expected [${texts.length},${seqLen},${manifest.dimension}]`,
    );
  }
  const data = hidden.data;
  if (!(data instanceof Float32Array)) {
    throw new Error(`unexpected last_hidden_state data type: ${Object.prototype.toString.call(data)}`);
  }
  const vectors: number[][] = [];
  for (let item = 0; item < texts.length; item += 1) {
    const start = item * sequence * dim;
    vectors.push(l2Normalize(Array.from(data.subarray(start, start + dim))));
  }
  return {
    vectors,
    dim: manifest.dimension,
    inputTokens: tokenized.reduce((sum, entry) => sum + entry.attentionMask.reduce((a, b) => a + b, 0), 0),
    elapsedMs: performance.now() - started,
  };
}

function assertModelSignature(session: ort.InferenceSession): void {
  const inputs = new Set(session.inputNames);
  for (const required of ["input_ids", "attention_mask", "token_type_ids"]) {
    if (!inputs.has(required)) throw new Error(`ONNX model missing required input: ${required}`);
  }
  if (!session.outputNames.includes("last_hidden_state")) {
    throw new Error(`ONNX model missing last_hidden_state output; got ${session.outputNames.join(", ")}`);
  }
}

function loadVocab(vocabPath: string): ReadonlyMap<string, number> {
  const lines = readFileSync(vocabPath, "utf8").split(/\r?\n/u);
  const entries = new Map<string, number>();
  lines.forEach((token, index) => {
    if (token.length > 0) entries.set(token, index);
  });
  for (const token of [CLS_TOKEN, SEP_TOKEN, PAD_TOKEN, UNK_TOKEN]) {
    if (!entries.has(token)) throw new Error(`BERT vocab missing required token ${token}`);
  }
  return entries;
}

function tokenizeText(text: string, vocab: ReadonlyMap<string, number>, maxTokens: number): TokenizedText {
  const cls = requiredToken(vocab, CLS_TOKEN);
  const sep = requiredToken(vocab, SEP_TOKEN);
  const pad = requiredToken(vocab, PAD_TOKEN);
  const pieces = basicTokenize(text).flatMap((token) => wordPieceTokenize(token, vocab));
  const payload = pieces.slice(0, Math.max(0, maxTokens - 2)).map((token) => vocab.get(token) ?? requiredToken(vocab, UNK_TOKEN));
  const ids = [cls, ...payload, sep];
  return {
    ids,
    attentionMask: ids.map(() => 1),
    tokenTypeIds: ids.map(() => 0),
  };

  void pad;
}

function basicTokenize(text: string): string[] {
  const stripped = stripAccents(text.normalize("NFKC").toLowerCase()).replace(/[\p{Cc}\p{Cf}]/gu, " ");
  const tokens: string[] = [];
  let current = "";
  for (const char of Array.from(stripped)) {
    if (isWhitespace(char)) {
      flush();
      continue;
    }
    if (isCjk(char) || isPunctuation(char)) {
      flush();
      tokens.push(char);
      continue;
    }
    current += char;
  }
  flush();
  return tokens;

  function flush(): void {
    if (current) {
      tokens.push(current);
      current = "";
    }
  }
}

function wordPieceTokenize(token: string, vocab: ReadonlyMap<string, number>): string[] {
  if (token.length > MAX_WORDPIECE_CHARS) return [UNK_TOKEN];
  const subTokens: string[] = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length;
    let current: string | null = null;
    while (start < end) {
      const candidate = `${start > 0 ? "##" : ""}${token.slice(start, end)}`;
      if (vocab.has(candidate)) {
        current = candidate;
        break;
      }
      end -= 1;
    }
    if (current === null) return [UNK_TOKEN];
    subTokens.push(current);
    start = end;
  }
  return subTokens;
}

function toInt64TensorData(
  tokenized: readonly TokenizedText[],
  seqLen: number,
  field: keyof TokenizedText,
): BigInt64Array {
  const data = new BigInt64Array(tokenized.length * seqLen);
  tokenized.forEach((entry, row) => {
    const values = entry[field];
    for (let col = 0; col < seqLen; col += 1) {
      data[row * seqLen + col] = BigInt(values[col] ?? 0);
    }
  });
  return data;
}

function requiredToken(vocab: ReadonlyMap<string, number>, token: string): number {
  const id = vocab.get(token);
  if (id === undefined) throw new Error(`BERT vocab missing ${token}`);
  return id;
}

function l2Normalize(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("embedding vector has invalid norm");
  return vector.map((value) => value / norm);
}

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/\p{Mark}/gu, "");
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function isPunctuation(char: string): boolean {
  return /\p{P}/u.test(char);
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function platformSidecars(): string[] {
  if (process.platform === "win32") return ["onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"];
  if (process.platform === "darwin") return ["libonnxruntime.1.22.0.dylib"];
  if (process.platform === "linux") return ["libonnxruntime.so.1"];
  return [];
}

function readPositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))] ?? 0;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertInside(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`model asset path escapes model root: ${label}`);
  }
}
