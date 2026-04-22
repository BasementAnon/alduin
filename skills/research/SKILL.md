---
id: research
description: Deep research and analysis with structured findings
inputs:
  - name: query
    type: string
    required: true
    description: The research question or topic to investigate
  - name: context
    type: string
    required: false
    description: Background context or constraints for the research
  - name: depth
    type: string
    required: false
    description: "Research depth: 'quick' (1-2 paragraphs), 'standard' (full analysis), 'deep' (multi-angle)"
model_hints:
  prefer:
    - frontier
  fallback_local: false
env_required: []
os: null
allow_sub_orchestration: false
allow_fs: false
allow_net: false
---

## System prompt

You are a research analyst. Your task is to provide thorough, well-structured analysis on the given topic using your training knowledge.

**Rules:**
1. Structure your response with clear sections: Background, Key Findings, Analysis, and Conclusion.
2. Distinguish clearly between established facts, expert consensus, and areas of active debate.
3. When presenting multiple viewpoints, give each fair treatment and note the strength of evidence behind each.
4. Cite specific data points, dates, and figures where available from your training data.
5. Flag any areas where your knowledge may be outdated and recommend verification.
6. Match the depth parameter: 'quick' = 1-2 paragraphs, 'standard' = full structured analysis, 'deep' = comprehensive multi-angle treatment.

**Output format:**
Return a markdown document with clear section headings and prose paragraphs. Use inline citations where possible (e.g., "according to X study (2024)").

## Inputs

Expected shape:
```json
{
  "query": "<research question>",
  "context": "<optional background>",
  "depth": "standard"
}
```

Example:
```json
{
  "query": "What are the trade-offs between transformer and state-space model architectures for long-context language modeling?",
  "context": "Evaluating architecture choices for a new project handling 100k+ token contexts",
  "depth": "standard"
}
```

## Outputs

Expected shape: A markdown document with sections.

Example:
```markdown
## Background
Transformer architectures have dominated language modeling since 2017, but their O(n²) attention complexity creates challenges at long context lengths...

## Key Findings
1. State-space models (Mamba, S4) achieve linear scaling with sequence length...
2. Hybrid architectures combining attention and SSM layers show promise...

## Analysis
For contexts exceeding 100k tokens, the practical trade-offs center on...

## Conclusion
For the described use case, a hybrid architecture offers the best balance...

*Note: This analysis reflects knowledge through early 2025. Verify benchmark results for models released after this date.*
```

## Notes

- `fallback_local: false` because research quality degrades significantly on small models — accurate recall and nuanced analysis require frontier-class capabilities.
- This skill does NOT have network access. For real-time research (current news, live data), the orchestrator should pair this with a web-search tool plugin when available.
- The `depth` parameter maps to approximate token budgets internally: quick ≈ 500 tokens, standard ≈ 2000 tokens, deep ≈ 5000 tokens.
