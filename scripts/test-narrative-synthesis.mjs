// Bypass test: agentmemory-style direct synthesis via raw OpenAI API.
// No planner/renderer/section-patch — one LLM call: current narrative + facts → new narrative.
// Pattern matches what agentmemory uses on gpt-4o-mini.
//
// Usage: node scripts/test-narrative-synthesis.mjs
import fs from "node:fs";
import path from "node:path";

const VAULT = "C:/Users/Admin/.memory";
const PAGE_PATH = `${VAULT}/wiki/projects/memory-system.md`;
const FACTS_DIR = `${VAULT}/facts`;
const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) { console.error("missing OPENROUTER_API_KEY"); process.exit(1); }

const SYSTEM_PROMPT = `You are a memory consolidation engine for an AI agent's persistent memory.

You are given:
  1. CURRENT MEMORY — a frontmatter block + ONE prose narrative body (no headings, no bullet lists)
  2. NEW FACTS — a list of recently observed facts about the same entity

Your job: produce an UPDATED memory in the same format. The body MUST be ONE prose narrative — no headings (## anything), no bullet lists, no checkboxes, no code blocks. Integrate genuinely new facts into the prose. Replace stale claims (e.g. "Phase X is planned" → "Phase X is shipped" if facts show shipping). Drop workflow noise (subagent boilerplate, session IDs, brief metadata). Keep wikilinks ([[...]]) inline. Preserve the frontmatter shape exactly — bump 'updated' to 2026-06-01, increment 'version' by 1, set 'supersedes' to a list with the previous version number.

Return ONLY the updated memory record: frontmatter delimited by --- on its own lines, then a blank line, then the prose narrative. No commentary. No appendix.`;

function collectFacts(maxFacts = 8) {
  const facts = [];
  const days = fs.readdirSync(FACTS_DIR).sort().reverse();
  for (const day of days) {
    if (facts.length >= maxFacts) break;
    const dayDir = path.join(FACTS_DIR, day);
    let stat;
    try { stat = fs.statSync(dayDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(dayDir)) {
      if (facts.length >= maxFacts) break;
      try {
        const bundle = JSON.parse(fs.readFileSync(path.join(dayDir, file), "utf-8"));
        for (const fact of bundle.facts || []) {
          if (facts.length >= maxFacts) break;
          const blob = JSON.stringify(fact).toLowerCase();
          if (blob.includes("memory-system") || blob.includes("memory fort") || blob.includes("memory-fort")) {
            if (fact.importance >= 6) facts.push({ ...fact, source: file });
          }
        }
      } catch {}
    }
  }
  return facts;
}

const current = fs.readFileSync(PAGE_PATH, "utf-8");
const facts = collectFacts(8);
console.error(`Selected ${facts.length} facts (importance >= 6) about memory-system`);
if (facts.length === 0) {
  console.error("WARN: no matching facts. Test inconclusive.");
}

const userPrompt = `CURRENT MEMORY:
\`\`\`
${current}
\`\`\`

NEW FACTS (top ${facts.length} by importance):
${facts.map((f, i) => `[${i+1}] (importance ${f.importance}) ${f.title}\n${f.narrative}\nFacts: ${f.facts.join("; ")}`).join("\n\n")}

Produce the updated memory record now.`;

console.error(`Calling openrouter openai/gpt-4o-mini with ${userPrompt.length} char user prompt...`);
const t0 = Date.now();
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://memory-fort.local",
    "X-Title": "memory-fort narrative test",
  },
  body: JSON.stringify({
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
  }),
});
const elapsed = Date.now() - t0;

if (!response.ok) {
  console.error(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(2);
}
const data = await response.json();
const out = data.choices?.[0]?.message?.content ?? "";
console.error(`Done in ${elapsed}ms, ${data.usage?.total_tokens ?? "?"} tokens`);
console.log(out);
