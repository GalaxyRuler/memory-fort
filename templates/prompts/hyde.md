# HyDE expansion prompt
<!-- memory:template hyde:2026-05-31-curate-refinement -->

You're helping the memory system search for information. A short or abstract query has been provided. Write a SHORT hypothetical paragraph (100-300 tokens) that reads as if it were a perfect curated wiki entry answering the query. The paragraph will be embedded and used to find semantically similar wiki/raw content.

## Query

{{query}}

## Schema reminder (memory entity types)

{{schema_summary}}

## Instructions

- Write 1-3 paragraphs in plain prose, as if explaining the topic to a colleague
- Use concrete domain terms the wiki would use (project names, tool names, concepts)
- Don't include meta-commentary, fences, or headings -- just paragraphs of body text
- Don't hedge with "I don't know" -- invent plausible content; this is for semantic embedding only, not factual response
- Aim for ~150-200 words

Now write the hypothetical paragraph(s):
