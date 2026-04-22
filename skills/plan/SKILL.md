---
id: plan
description: Break a complex task into an executable multi-step plan
inputs:
  - name: task
    type: string
    required: true
    description: The task or goal to plan for
  - name: constraints
    type: string
    required: false
    description: Budget, time, or capability constraints to respect
  - name: available-skills
    type: string
    required: false
    description: Comma-separated list of available skill IDs for delegation
model_hints:
  prefer:
    - frontier
  fallback_local: false
env_required: []
os: null
allow_sub_orchestration: true
allow_fs: false
allow_net: false
---

## System prompt

You are a task planning specialist. Your job is to decompose a complex task into a clear, ordered sequence of executable steps.

**Rules:**
1. Each step must be concrete and actionable — not vague ("research the topic" is vague; "identify the 3 main competing approaches and summarize each in 2 sentences" is actionable).
2. Identify dependencies between steps explicitly. Steps that can run in parallel should be marked as such.
3. For each step, suggest which skill or executor is best suited (from the available-skills list if provided).
4. If a step is itself complex enough to warrant sub-planning, mark it with `[recursive]` — the orchestrator may spawn a child orchestration for it.
5. Include estimated token budget per step (rough: small=500, medium=2000, large=5000).
6. End with a risk assessment: what could go wrong, and what's the fallback.
7. Respect any constraints provided (budget, time, model availability).

**Output format:**
Return a structured plan in markdown with numbered steps, dependencies, and the risk section.

## Inputs

Expected shape:
```json
{
  "task": "<complex task description>",
  "constraints": "<optional constraints>",
  "available-skills": "summarize,research,code-review,extract,rewrite"
}
```

Example:
```json
{
  "task": "Analyze the top 5 competitors in the AI code assistant market and produce a comparison report with strengths, weaknesses, pricing, and a recommendation.",
  "constraints": "Budget: $0.50 total. No network access — use training knowledge only.",
  "available-skills": "summarize,research,extract,rewrite"
}
```

## Outputs

Expected shape: A markdown plan document.

Example:
```markdown
## Plan: Competitor Analysis Report

### Steps

1. **Research each competitor** (skill: research, depth: standard)
   Budget: ~2000 tokens × 5 = 10000 tokens
   Parallelizable: Yes — all 5 can run concurrently
   - GitHub Copilot
   - Cursor
   - Cody (Sourcegraph)
   - Tabnine
   - Amazon CodeWhisperer

2. **Extract structured data** (skill: extract) [recursive]
   Depends on: Step 1
   Budget: ~1000 tokens
   Extract from each research output: name, pricing tiers, key features, limitations, target audience

3. **Synthesize comparison** (skill: rewrite)
   Depends on: Step 2
   Budget: ~2000 tokens
   Combine extracted data into a comparison table and narrative analysis

4. **Write recommendation** (skill: summarize)
   Depends on: Step 3
   Budget: ~500 tokens
   Produce a final recommendation with rationale

### Risk Assessment
- **Knowledge cutoff**: Pricing and features may be outdated. Flag this in the output.
- **Budget constraint**: At $0.50, prefer local models for steps 1-2 if available.
- **Parallelism**: Step 1 benefits from parallel execution to reduce latency.
```

## Notes

- **This is the showcase skill for recursive orchestration.** `allow_sub_orchestration: true` lets the orchestrator spawn child orchestrations for steps marked `[recursive]`, enabling complex multi-model workflows where a frontier model plans and local models execute.
- `fallback_local: false` because planning quality is critical — a bad plan wastes all downstream compute. Always use a frontier model for the planner.
- The `available-skills` input helps the planner make realistic step assignments. If omitted, the planner will suggest generic executor types.
- Max recursion depth is 2 (enforced by RecursionGuard), so plans should not assume deeper nesting.
