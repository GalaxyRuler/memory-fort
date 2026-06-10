export interface DispatchPolicyGoldEntry {
  scenario: string;
  type: "duplicate" | "contradiction" | "supersession" | "noop" | "novel";
  raw_content: string;
  existing_page?: string;
  existing_body?: string;
  expected_op: "noop" | "write_page" | "rewrite_page" | "dispute_page" | "supersede_page";
  // Optional explicit inputs for policy eval (overrides defaults when present):
  similarity?: number;
  conflict_type?: string;
}

export interface DispatchPolicyEvalResult {
  scenario: string;
  type: string;
  expected: string;
  got: string;
  correct: boolean;
}

export interface DispatchPolicyEvalReport {
  total: number;
  correct: number;
  accuracy: number;
  byType: Record<string, { total: number; correct: number; accuracy: number }>;
  results: DispatchPolicyEvalResult[];
}
