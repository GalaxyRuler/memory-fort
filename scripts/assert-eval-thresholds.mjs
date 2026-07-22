#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(resolve(path), "utf-8");
  } catch (error) {
    throw new Error(`could not read ${label} ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function finiteNumber(value, label, failures) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failures.push(`${label} is missing or is not a finite number`);
    return undefined;
  }
  return value;
}

function atLeast(actual, minimum, label, failures) {
  const number = finiteNumber(actual, label, failures);
  if (number !== undefined && number < minimum) {
    failures.push(`${label} ${number} is below minimum ${minimum}`);
  }
}

function validateRetrieval(report, thresholds) {
  const failures = [];
  atLeast(report.questionCount, thresholds.minimumQuestionCount, "questionCount", failures);

  for (const category of thresholds.requiredCategories ?? []) {
    const breakdown = report.byType?.[category];
    if (breakdown == null) {
      failures.push(`missing required category: ${category}`);
      continue;
    }
    atLeast(breakdown.questionCount, 1, `category ${category} questionCount`, failures);
  }

  const tolerance = thresholds.graphLiftConsistencyTolerance ?? 0.0001;
  const recallKeys = new Set([
    ...Object.keys(thresholds.minimumRecallWithGraph ?? {}),
    ...Object.keys(thresholds.minimumGraphLift ?? {}),
  ]);
  for (const k of recallKeys) {
    const withGraph = finiteNumber(report.recall?.[k]?.withGraph, `recall@${k}.withGraph`, failures);
    const withoutGraph = finiteNumber(report.recall?.[k]?.withoutGraph, `recall@${k}.withoutGraph`, failures);
    const graphLift = finiteNumber(report.graphLift?.[k], `graphLift@${k}`, failures);

    const minimumRecall = thresholds.minimumRecallWithGraph?.[k];
    if (withGraph !== undefined && minimumRecall !== undefined && withGraph < minimumRecall) {
      failures.push(`recall@${k}.withGraph ${withGraph} is below minimum ${minimumRecall}`);
    }
    const minimumLift = thresholds.minimumGraphLift?.[k];
    if (graphLift !== undefined && minimumLift !== undefined && graphLift < minimumLift) {
      failures.push(`graphLift@${k} ${graphLift} is below minimum ${minimumLift}`);
    }
    if (
      withGraph !== undefined &&
      withoutGraph !== undefined &&
      graphLift !== undefined &&
      Math.abs(graphLift - (withGraph - withoutGraph)) > tolerance
    ) {
      failures.push(
        `graphLift@${k} is inconsistent with recall: reported ${graphLift}, expected ${withGraph - withoutGraph}`,
      );
    }
  }

  atLeast(report.mrr?.withGraph, thresholds.minimumMrrWithGraph, "mrr.withGraph", failures);
  finiteNumber(report.mrr?.withoutGraph, "mrr.withoutGraph", failures);
  return failures;
}

function validateDispatch(report, thresholds) {
  const failures = [];
  const total = finiteNumber(report.total, "dispatch total", failures);
  const correct = finiteNumber(report.correct, "dispatch correct", failures);
  const accuracy = finiteNumber(report.accuracy, "dispatch accuracy", failures);
  if (total !== undefined && total < thresholds.minimumTotal) {
    failures.push(`dispatch total ${total} is below minimum ${thresholds.minimumTotal}`);
  }
  if (accuracy !== undefined && accuracy < thresholds.minimumAccuracy) {
    failures.push(`dispatch accuracy ${accuracy} is below minimum ${thresholds.minimumAccuracy}`);
  }
  if (total !== undefined && correct !== undefined && accuracy !== undefined && total > 0) {
    const expected = correct / total;
    if (Math.abs(accuracy - expected) > 1e-9) {
      failures.push(`dispatch accuracy is inconsistent: reported ${accuracy}, expected ${expected}`);
    }
  }

  for (const category of thresholds.requiredCategories ?? []) {
    const breakdown = report.byType?.[category];
    if (breakdown == null) {
      failures.push(`missing required category: ${category}`);
      continue;
    }
    const categoryTotal = finiteNumber(breakdown.total, `dispatch category ${category} total`, failures);
    const categoryCorrect = finiteNumber(breakdown.correct, `dispatch category ${category} correct`, failures);
    const categoryAccuracy = finiteNumber(breakdown.accuracy, `dispatch category ${category} accuracy`, failures);
    if (categoryTotal !== undefined && categoryTotal < 1) {
      failures.push(`dispatch category ${category} has no cases`);
    }
    if (categoryAccuracy !== undefined && categoryAccuracy < thresholds.minimumCategoryAccuracy) {
      failures.push(
        `dispatch category ${category} accuracy ${categoryAccuracy} is below minimum ${thresholds.minimumCategoryAccuracy}`,
      );
    }
    if (
      categoryTotal !== undefined &&
      categoryCorrect !== undefined &&
      categoryAccuracy !== undefined &&
      categoryTotal > 0 &&
      Math.abs(categoryAccuracy - categoryCorrect / categoryTotal) > 1e-9
    ) {
      failures.push(`dispatch category ${category} accuracy is inconsistent`);
    }
  }
  return failures;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.kind !== "retrieval" && args.kind !== "dispatch") {
    throw new Error("--kind must be retrieval or dispatch");
  }
  if (!args.report) throw new Error("--report is required");
  const thresholdsPath = args.thresholds ?? "qa/eval-thresholds.json";
  const thresholds = readJson(thresholdsPath, "threshold configuration");
  if (thresholds.schemaVersion !== 1) {
    throw new Error(`unsupported threshold schemaVersion: ${thresholds.schemaVersion}`);
  }
  const report = readJson(args.report, `${args.kind} report`);
  const policy = thresholds[args.kind];
  if (policy == null) throw new Error(`missing ${args.kind} threshold policy`);

  const failures = args.kind === "retrieval"
    ? validateRetrieval(report, policy)
    : validateDispatch(report, policy);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`eval-thresholds: ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${args.kind} thresholds passed\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`eval-thresholds: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
