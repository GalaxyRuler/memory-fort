import type { EmbeddingRecord } from "./embeddings-store.js";

export interface EmbeddingHealthOptions {
  expectedDim?: number;
  minDim?: number;
  sampleSize?: number;
}

export interface EmbeddingHealthAnalysis {
  total: number;
  dims: number[];
  healthy: boolean;
  issues: string[];
}

const DEFAULT_MIN_DIM = 16;
const DEFAULT_SAMPLE_SIZE = 64;

export function analyzeEmbeddingHealth(
  records: EmbeddingRecord[],
  opts: EmbeddingHealthOptions = {},
): EmbeddingHealthAnalysis {
  const minDim = readPositiveInteger(opts.minDim, DEFAULT_MIN_DIM);
  const expectedDim = readPositiveInteger(opts.expectedDim, undefined);
  const sampleSize = readPositiveInteger(opts.sampleSize, DEFAULT_SAMPLE_SIZE) ?? DEFAULT_SAMPLE_SIZE;
  const sample = records.slice(0, Math.max(1, sampleSize));
  const dims = [...new Set(records.map((record) => record.dim))].sort((a, b) => a - b);
  const issues: string[] = [];

  const lowDims = dims.filter((dim) => dim < minDim);
  if (lowDims.length > 0) {
    issues.push(`dim ${lowDims.join(", ")} below sane floor ${minDim}`);
  }

  if (expectedDim !== undefined) {
    const unexpectedDims = dims.filter((dim) => dim !== expectedDim);
    if (unexpectedDims.length > 0) {
      issues.push(`dim ${unexpectedDims.join(", ")} != expected ${expectedDim}`);
    }
  }

  if (sample.length > 1 && allSame(sample.map((record) => vectorKey(record.vector)))) {
    issues.push("sample vectors are identical");
  }

  if (sample.length > 0 && sample.every((record) => isUnitStubVector(record.vector))) {
    issues.push("sample vectors are all [1,0,0] stubs");
  }

  if (sample.length > 0 && sample.every((record) => isZeroVector(record.vector))) {
    issues.push("sample vectors are all zero");
  }

  return {
    total: records.length,
    dims,
    healthy: issues.length === 0,
    issues,
  };
}

export function hasUsableEmbeddingDimensions(
  records: EmbeddingRecord[],
  opts: EmbeddingHealthOptions = {},
): boolean {
  return analyzeEmbeddingHealth(records, opts).issues.filter((issue) =>
    issue.startsWith("dim ")
  ).length === 0;
}

export function vectorsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

export function isUnitStubVector(vector: number[]): boolean {
  return vector.length === 3 && vector[0] === 1 && vector[1] === 0 && vector[2] === 0;
}

export function isZeroVector(vector: number[]): boolean {
  return vector.length > 0 && vector.every((value) => value === 0);
}

function vectorKey(vector: number[]): string {
  return vector.map((value) => Object.is(value, -0) ? "-0" : String(value)).join(",");
}

function allSame(values: string[]): boolean {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first);
}

function readPositiveInteger(value: number | undefined, fallback: number): number;
function readPositiveInteger(value: number | undefined, fallback: undefined): number | undefined;
function readPositiveInteger(value: number | undefined, fallback: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
