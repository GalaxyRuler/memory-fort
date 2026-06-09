export type ConflictType = "contradiction" | "supersession" | "noop" | "update";

export interface DispatchInput {
  similarity: number;
  threshold: number;
  existingPageDate: string;
  newSessionDate: string;
  conflictType: ConflictType | string;
}

export type DispatchResult =
  | { kind: "dispute_page" }
  | { kind: "supersede_page" }
  | { kind: "rewrite_page" }
  | { kind: "noop" };

export function classifyDispatch(input: DispatchInput): DispatchResult {
  if (input.conflictType === "noop") {
    return { kind: "noop" };
  }

  const hasAuthority =
    input.similarity >= input.threshold &&
    isMoreRecent(input.newSessionDate, input.existingPageDate);

  if (!hasAuthority) {
    return { kind: "rewrite_page" };
  }

  if (input.conflictType === "contradiction") {
    return { kind: "dispute_page" };
  }

  if (input.conflictType === "supersession") {
    return { kind: "supersede_page" };
  }

  return { kind: "rewrite_page" };
}

function isMoreRecent(newDate: string, oldDate: string): boolean {
  return new Date(newDate).getTime() > new Date(oldDate).getTime();
}
