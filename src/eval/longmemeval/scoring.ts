export interface RecallInput {
  expected: string[];
  retrieved: string[];
}

export function hitAtK(
  expected: string[],
  retrieved: string[],
  k: number,
): boolean {
  if (k <= 0 || expected.length === 0 || retrieved.length === 0) return false;
  const expectedSet = new Set(expected.map(normalizeEvidenceId));
  return retrieved
    .slice(0, k)
    .map(normalizeEvidenceId)
    .some((path) => expectedSet.has(path));
}

export function recallAtK(questions: RecallInput[], k: number): number {
  if (questions.length === 0) return 0;
  const hits = questions.filter((question) =>
    hitAtK(question.expected, question.retrieved, k),
  ).length;
  return hits / questions.length;
}

export function normalizeEvidenceId(path: string): string {
  return path.replace(/\\/g, "/");
}
