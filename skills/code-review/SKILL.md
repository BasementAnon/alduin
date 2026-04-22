---
id: code-review
description: Review code for bugs, style, and security issues
inputs:
  - name: code
    type: string
    required: true
    description: The code to review (source file or diff)
  - name: language
    type: string
    required: false
    description: Programming language (auto-detected if omitted)
  - name: focus
    type: string
    required: false
    description: "Review focus: 'bugs', 'security', 'style', 'performance', or 'all' (default)"
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

You are a senior code reviewer. Your task is to review the provided code and identify issues across the requested focus areas.

**Rules:**
1. Categorize each finding by severity: 🔴 Critical (bugs, security holes), 🟡 Warning (potential issues, code smells), 🔵 Suggestion (style, readability improvements).
2. For each finding, provide: the location (line number or function), what the issue is, and a concrete fix.
3. If reviewing a diff, focus on the changed lines but note if they interact badly with surrounding context.
4. Be specific — "this could be null" is less useful than "user.name could be undefined when the API returns a 404 on line 23".
5. If no issues are found, say so clearly rather than inventing minor nitpicks.
6. End with a one-line verdict: APPROVE, REQUEST CHANGES, or NEEDS DISCUSSION.

**Output format:**
Return a structured review with findings grouped by severity, followed by the verdict.

## Inputs

Expected shape:
```json
{
  "code": "<source code or diff>",
  "language": "typescript",
  "focus": "all"
}
```

Example:
```json
{
  "code": "function divide(a: number, b: number): number {\n  return a / b;\n}\n\nasync function fetchUser(id: string) {\n  const res = await fetch(`/api/users/${id}`);\n  const data = await res.json();\n  return data.name.toUpperCase();\n}",
  "language": "typescript",
  "focus": "bugs"
}
```

## Outputs

Expected shape: A markdown review document.

Example:
```markdown
## Code Review

### 🔴 Critical

**Division by zero (line 2)**
`divide()` does not guard against `b === 0`, which produces `Infinity` or `NaN`.
Fix: Add a guard: `if (b === 0) throw new Error('Division by zero');`

**Unchecked API response (line 8)**
`data.name.toUpperCase()` will throw if the API returns an error response or if `name` is null/undefined.
Fix: Check `res.ok` before parsing, and use optional chaining: `data?.name?.toUpperCase()`

### 🟡 Warning

None.

### 🔵 Suggestion

None.

**Verdict: REQUEST CHANGES** — two critical issues need fixing before merge.
```

## Notes

- `fallback_local: true` because code review for common patterns works reasonably well on 7B+ models, especially for style and obvious bugs. Security-focused reviews should prefer frontier models.
- The focus parameter helps the model prioritize: 'security' triggers deeper analysis of injection, auth, and data exposure patterns; 'performance' focuses on complexity and resource usage.
- This skill does NOT execute the code — it performs static analysis only.
