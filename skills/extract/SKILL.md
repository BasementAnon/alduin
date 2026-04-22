---
id: extract
description: Extract structured data from unstructured text
inputs:
  - name: text
    type: string
    required: true
    description: The unstructured text to extract data from
  - name: schema
    type: json
    required: true
    description: JSON schema describing the desired output structure
  - name: examples
    type: string
    required: false
    description: One or more examples of expected output for few-shot guidance
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

You are a data extraction specialist. Your task is to extract structured data from unstructured text according to a provided schema.

**Rules:**
1. Output ONLY valid JSON matching the provided schema. No markdown, no explanation, no commentary.
2. If a field cannot be determined from the text, use `null` rather than guessing.
3. For array fields, extract all matching instances — do not truncate.
4. Preserve exact values from the source: do not paraphrase names, numbers, dates, or identifiers.
5. Dates should be normalized to ISO 8601 format (YYYY-MM-DD) unless the schema specifies otherwise.
6. If the text contains multiple records (e.g., a table or list), return an array of objects.

**Output format:**
Return a single JSON object (or array) matching the provided schema. No wrapping markdown code fences.

## Inputs

Expected shape:
```json
{
  "text": "<unstructured text>",
  "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "date": { "type": "string", "format": "date" },
      "amount": { "type": "number" }
    }
  }
}
```

Example:
```json
{
  "text": "Invoice #4821 from Acme Corp dated March 15, 2025 for $12,450.00. Payment terms: Net 30. Contact: billing@acme.com",
  "schema": {
    "type": "object",
    "properties": {
      "invoice_number": { "type": "string" },
      "vendor": { "type": "string" },
      "date": { "type": "string" },
      "amount": { "type": "number" },
      "payment_terms": { "type": "string" },
      "contact_email": { "type": "string" }
    }
  }
}
```

## Outputs

Expected shape: A JSON object matching the schema.

Example:
```json
{
  "invoice_number": "4821",
  "vendor": "Acme Corp",
  "date": "2025-03-15",
  "amount": 12450.00,
  "payment_terms": "Net 30",
  "contact_email": "billing@acme.com"
}
```

## Notes

- `fallback_local: true` because extraction with a clear schema works well on smaller models, especially for simple flat schemas. Complex nested schemas with many optional fields benefit from frontier models.
- The `examples` input enables few-shot prompting which significantly improves extraction accuracy on domain-specific formats.
- This skill outputs raw JSON, not markdown. The orchestrator or downstream skill handles formatting for the user.
- For very long texts with many records, consider chunking the input and calling this skill per chunk, then merging results.
