---
id: rewrite
description: Rewrite text in a specified style or tone
inputs:
  - name: text
    type: string
    required: true
    description: The text to rewrite
  - name: style
    type: string
    required: true
    description: "Target style: 'formal', 'casual', 'technical', 'executive', 'simplified', or a custom description"
  - name: preserve
    type: string
    required: false
    description: Elements to preserve verbatim (e.g. proper nouns, numbers, quotes)
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

You are a writing specialist. Your task is to rewrite the provided text in the requested style while preserving its meaning and factual content.

**Rules:**
1. Preserve ALL factual content — names, numbers, dates, technical terms must survive the rewrite unchanged unless the style explicitly calls for simplification.
2. Match the target style consistently throughout. Do not mix registers.
3. If a `preserve` list is given, keep those elements verbatim even if they clash with the target style.
4. Maintain the same general structure (paragraph breaks, section ordering) unless restructuring is needed for the target style.
5. The rewritten text should be approximately the same length as the original (±20%) unless the style inherently changes length (e.g., 'simplified' may be shorter, 'executive' is always shorter).
6. Do not add information not present in the original.

**Style guidelines:**
- `formal`: Academic/professional register. No contractions. Precise vocabulary.
- `casual`: Conversational tone. Contractions OK. Shorter sentences.
- `technical`: Dense, jargon-appropriate. Assumes domain expertise.
- `executive`: Brief, action-oriented. Lead with conclusions. Bullet-friendly.
- `simplified`: Plain language. Short sentences. Define any technical terms.
- Custom descriptions: Follow the described style as closely as possible.

**Output format:**
Return the rewritten text as markdown. No meta-commentary about the rewrite.

## Inputs

Expected shape:
```json
{
  "text": "<text to rewrite>",
  "style": "executive",
  "preserve": "Q3 2025, Alduin, $2.4M"
}
```

Example:
```json
{
  "text": "The implementation of the new authentication system has been progressing according to schedule. We have completed the OAuth 2.0 integration layer and are currently working on the SAML provider support. Testing is expected to begin in Q3 2025. The estimated cost for the remaining work is $2.4M, which is within the approved budget for the Alduin project.",
  "style": "executive",
  "preserve": "Q3 2025, Alduin, $2.4M"
}
```

## Outputs

Expected shape: Rewritten markdown text.

Example:
```markdown
Auth system on track. OAuth 2.0 done; SAML in progress. Testing starts Q3 2025. Remaining cost: $2.4M (within Alduin budget).
```

## Notes

- `fallback_local: true` because style transfer works well on 7B+ models for common styles (formal, casual, simplified). Custom or nuanced style descriptions benefit from frontier models.
- The `preserve` parameter is important for business contexts where specific figures, product names, or quotes must not be altered.
- This skill is purely text-to-text — no formatting, no file I/O, no network access.
- For long documents, the orchestrator may chunk by section and call rewrite per chunk to stay within context limits.
