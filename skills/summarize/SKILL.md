---
id: summarize
description: Summarize a document or text into a concise overview
inputs:
  - name: document
    type: string
    required: true
    description: The text or document content to summarize
  - name: max-length
    type: number
    required: false
    description: Target summary length in words (default 200)
model_hints:
  prefer:
    - frontier
  fallback_local: true
env_required: []
os: null
allow_sub_orchestration: false
allow_fs: false
allow_net: false
---

## System prompt

You are a summarization specialist. Your task is to produce a clear, accurate summary of the provided document.

**Rules:**
1. Preserve all key facts, figures, and conclusions from the source.
2. Use the same language as the source document unless instructed otherwise.
3. If the document contains structured sections, reflect that structure in your summary with brief sub-headings.
4. Never invent information not present in the source.
5. If a target length is provided, stay within ±10% of that word count.
6. Begin with a one-sentence TL;DR, then expand into the full summary.

**Output format:**
Return a markdown document with:
- A bold **TL;DR** line
- The full summary in prose paragraphs

## Inputs

Expected shape:
```json
{
  "document": "<full text to summarize>",
  "max-length": 200
}
```

Example:
```json
{
  "document": "The Federal Reserve held interest rates steady at 5.25-5.50% at its March 2025 meeting, citing persistent inflation above the 2% target. Chair Powell noted that while labor markets remain resilient, the committee needs 'greater confidence' that inflation is moving sustainably toward target before cutting rates. Markets now price the first cut for June 2025.",
  "max-length": 50
}
```

## Outputs

Expected shape: A markdown string.

Example:
```markdown
**TL;DR:** The Fed held rates at 5.25-5.50% in March 2025, awaiting stronger evidence of inflation decline before cutting.

The Federal Reserve maintained its benchmark rate at the March meeting, with Chair Powell emphasizing the need for sustained progress on inflation before any easing. Markets are pricing the first rate cut for June 2025.
```

## Notes

- `fallback_local: true` because summarization works well on smaller models (Qwen 2.5 7B, Llama 3 8B) for shorter documents. The orchestrator should route to a local model when the input is under ~2000 tokens.
- For very long documents (>50k tokens), the orchestrator should chunk and call this skill multiple times rather than expecting a single pass.
- This skill does NOT shell out or hit the network — it operates purely on text provided in the input.
