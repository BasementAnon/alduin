# Design: Recursive Multi-Model Orchestration

> Phase 3.1 — design only, no implementation code.
> Implements ARCHITECTURE.md §3 ("Recursive Multi-Model Orchestration").

---

## 1. Type Additions

### 1.1 ExecutorTask — `orchestration` field

Add an optional `orchestration` object to `ExecutorTask` (in `src/executor/types.ts`):

```typescript
interface ExecutorTask {
  // … existing fields unchanged …

  orchestration?: {
    /** Whether this task is allowed to spawn a child orchestrator. Default false. */
    allow_sub_orchestration: boolean;

    /** Maximum recursion depth from root. Default 2, hard cap 4. */
    max_depth: number;

    /** Task ID of the parent that spawned this sub-orchestration. */
    parent_task_id?: string;

    /** Current depth in the recursion tree. 0 at the top level. */
    parent_depth: number;

    /** Parent's remaining cost budget in USD. Child cannot exceed this. */
    parent_budget_remaining_usd: number;

    /** Parent's remaining wall-clock timeout in ms. Child inherits this. */
    parent_timeout_remaining_ms: number;

    /** Model string the parent is running on. Used for affinity checks. */
    parent_model: string;

    /** Allow child to use the same model as parent. Default false. */
    allow_same_model_recursion?: boolean;
  };
}
```

### 1.2 ExecutorResult — `sub_orchestration` field

Add an optional `sub_orchestration` object to `ExecutorResult`:

```typescript
interface ExecutorResult {
  // … existing fields unchanged …

  /** New status literals added to the union: */
  status:
    | 'complete' | 'failed' | 'timeout' | 'budget_exceeded' | 'policy_denied'
    | 'recursion_depth_exceeded'
    | 'loop_detected'
    | 'model_affinity_violation';

  sub_orchestration?: {
    /** The child orchestrator's root task ID. */
    child_task_id: string;

    /** How many plan steps the child executed. */
    child_steps_executed: number;

    /** Total cost in USD consumed by the child tree. */
    child_cost_usd: number;

    /** Total wall-clock time the child tree took. */
    child_latency_ms: number;

    /** The depth at which the child ran. */
    child_depth: number;

    /** Model the child orchestrator used for planning. */
    child_model: string;
  };
}
```

### 1.3 PolicyVerdict — recursion fields

Extend `PolicyVerdict` (in `src/auth/policy.ts`) with two new optional fields:

```typescript
interface PolicyVerdict {
  // … existing fields unchanged …

  /** Maximum recursion depth this policy allows. Overrides per-task max_depth. */
  max_recursion_depth?: number;

  /** Per-session kill switch. When true, all sub-orchestration is blocked. */
  recursion_disabled?: boolean;
}
```

`DEFAULT_POLICY_VERDICT` gains `max_recursion_depth: 2` and `recursion_disabled: false`.

### 1.4 PlanStep — `sub_orchestrate` hint

The orchestrator's plan can request sub-orchestration on a per-step basis:

```typescript
interface PlanStep {
  // … existing fields unchanged …

  /** If set, this step should spawn a child orchestrator on the named model. */
  sub_orchestrate?: {
    child_model: string;
    child_system_prompt_mode: 'deterministic' | 'llm_assisted';
  };
}
```

The JSON schema constant `ORCHESTRATOR_PLAN_SCHEMA` is extended with matching `sub_orchestrate` properties.

### 1.5 Trace types

Add new event types to `TraceEventType`:

```typescript
type TraceEventType =
  | /* existing literals */
  | 'child_orchestration_started'
  | 'child_orchestration_completed'
  | 'child_orchestration_failed';
```

Extend `TraceEventData`:

```typescript
interface TraceEventData {
  // … existing fields …

  /** Recursion-specific fields */
  parent_task_id?: string;
  depth?: number;
  child_task_id?: string;
  child_model?: string;
  child_cost_usd?: number;
}
```

---

## 2. State Machine for a Recursive Call

A sub-orchestration follows a five-phase state machine. Each transition is an explicit function call, not an implicit side-effect.

```
┌──────────────┐
│  PRE-CHECK   │── fail ──→ [abort with status]
└──────┬───────┘
       │ pass
       ▼
┌──────────────┐
│ DISPATCH     │── spawn child OrchestratorLoop
│ CHILD        │
└──────┬───────┘
       │ child returns
       ▼
┌──────────────┐
│ COLLECT      │── extract child result + usage
│ RESULT       │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ ROLL COST UP │── deduct child_cost_usd from parent budget
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ WRITE TRACE  │── log child_orchestration_completed event
│ EDGE         │
└──────────────┘
```

### Phase details

**PRE-CHECK** (in `src/orchestrator/recursion.ts`):

1. **Depth guard**: `parent_depth + 1 > max_depth` → abort `recursion_depth_exceeded`.
2. **Policy guard**: `verdict.recursion_disabled === true` → abort `policy_denied`.
3. **Policy depth override**: `parent_depth + 1 > verdict.max_recursion_depth` → abort `recursion_depth_exceeded`.
4. **Model affinity**: `child_model === parent_model && !allow_same_model_recursion` → abort `model_affinity_violation`.
5. **Budget guard**: `parent_budget_remaining_usd <= 0` → abort `budget_exceeded`.
6. **Loop detection**: check `(parent_model, child_model, hash(instruction))` against the turn's edge set → abort `loop_detected`.

If all checks pass, register the edge in the turn-scoped loop detector.

**DISPATCH CHILD**: Construct a new `OrchestratorLoop` instance (or reuse one from a pool) with:
- Budget ceiling = `parent_budget_remaining_usd`
- Timeout = `parent_timeout_remaining_ms`
- Depth = `parent_depth + 1`
- Its own `TraceLogger` instance (child traces are independent but linked by `parent_task_id`)

Call `childLoop.processMessage(instruction, [], childVerdict)`. The child gets an empty conversation history — it operates on the instruction alone.

**COLLECT RESULT**: The child returns `{ response, trace }`. Map the child's `TaskTrace` into the parent's `ExecutorResult`:
- `summary` = child response (truncated to 500 tokens if needed)
- `sub_orchestration.child_cost_usd` = child trace's `total_cost_usd`
- `sub_orchestration.child_steps_executed` = count of child plan steps
- `sub_orchestration.child_latency_ms` = child trace's `total_latency_ms`

**ROLL COST UP**: Deduct `child_cost_usd` from the parent's `BudgetGuard`. This ensures:
- The parent's remaining budget shrinks by the child's actual spend.
- If the parent has more steps after the child, they see the reduced budget.
- The root-level budget dashboard shows the full recursive tree's cost.

**WRITE TRACE EDGE**: Log a `child_orchestration_completed` event on the parent's trace with `child_task_id`, `depth`, `child_model`, `child_cost_usd`. The child's own trace is stored independently in the `TraceLogger` keyed by `child_task_id`, linked back via `parent_task_id`.

---

## 3. Loop Detection Algorithm

### 3.1 Edge hash shape

Each sub-orchestration attempt produces an edge tuple:

```
(parent_model: string, child_model: string, instruction_hash: string)
```

`instruction_hash` is a SHA-256 of the normalized instruction string:
1. Trim whitespace.
2. Collapse runs of whitespace to single spaces.
3. Lowercase.
4. SHA-256 → hex (first 16 chars for compactness).

The hash is intentionally coarse — minor rephrasing by the orchestrator should still collide. If this proves too aggressive, a future iteration can use a semantic embedding similarity threshold instead.

### 3.2 Turn-scoped edge set

The edge set is a `Map<string, number>` keyed by the concatenation `parentModel|childModel|instructionHash`, valued by a monotonic counter (the attempt number).

**Scope**: one edge set per top-level `processMessage()` call (i.e., per user turn). When the turn completes, the set is discarded. This prevents cross-turn false positives while still catching intra-turn loops.

**Eviction**: no eviction within a turn. The edge set is bounded by the depth cap (max 4 levels) × the plan step count (typically ≤ 10), so the worst case is ~40 entries per turn. No memory pressure concern.

### 3.3 Detection rule

An edge is a loop if the same key appears **more than once** in the turn's edge set. The first occurrence is allowed; the second is rejected with `loop_detected`. This catches:
- A↔B ping-pong: A→B succeeds, B→A succeeds, A→B is blocked on the second attempt.
- Self-recursion cycles: A→A is blocked by model-affinity before the loop detector fires (unless `allow_same_model_recursion` is true, in which case the instruction hash catches it).

### 3.4 Implementation location

New file `src/orchestrator/recursion.ts` exports:

```typescript
class RecursionGuard {
  constructor(turnId: string);

  /** Run all pre-checks. Returns a RecursionVerdict. */
  preCheck(opts: {
    parentModel: string;
    childModel: string;
    instruction: string;
    parentDepth: number;
    maxDepth: number;
    parentBudgetRemaining: number;
    allowSameModelRecursion: boolean;
    verdict: PolicyVerdict;
  }): RecursionVerdict;

  /** Register an edge after a successful pre-check. */
  registerEdge(parentModel: string, childModel: string, instructionHash: string): void;
}

type RecursionVerdict =
  | { allowed: true }
  | { allowed: false; reason: RecursionDenialReason; message: string };

type RecursionDenialReason =
  | 'recursion_depth_exceeded'
  | 'loop_detected'
  | 'model_affinity_violation'
  | 'budget_exceeded'
  | 'policy_denied';
```

One `RecursionGuard` instance is created per turn in `OrchestratorLoop.processMessage()` and threaded through the call tree.

---

## 4. Budget Flow-Through Math

### 4.1 Ceiling propagation

```
root_ceiling = verdict.cost_ceiling_usd                (e.g. $2.00)
parent_spent = budgetGuard.currentSpend(sessionId)     (e.g. $0.35)
parent_remaining = root_ceiling - parent_spent         (e.g. $1.65)

child_ceiling = parent_remaining                       (→ $1.65)
```

The child's `BudgetGuard` is initialized with `limit = child_ceiling`. The child cannot exceed it.

### 4.2 Cost roll-up on child completion

When the child returns successfully:

```
child_actual_cost = childTrace.total_cost_usd          (e.g. $0.12)
parent.budgetGuard.postRecord(
  childTaskId, 'sub-orchestration', { input: 0, output: 0 }, child_actual_cost
)
```

This ensures the parent's `currentSpend` now includes the child's cost. Subsequent sibling steps in the same plan see the reduced budget.

### 4.3 Partial child spend on failure

If the child fails mid-execution (e.g., one of its steps succeeds, then the next times out):
- The child's `TraceLogger` has already accumulated the cost of completed steps.
- `childTrace.total_cost_usd` reflects only the tokens actually consumed.
- The parent rolls up this partial cost identically to the success case.

There is no "refund" mechanism — tokens consumed are tokens consumed.

### 4.4 Worked cost arithmetic

Given:
- Sonnet: $3/MTok input, $15/MTok output
- Ollama local: $0/MTok (free)
- Budget ceiling: $2.00

A three-level chain (API → local → API):

| Step | Model | Input tokens | Output tokens | Cost |
|------|-------|-------------|--------------|------|
| Root plan | Sonnet | 2,000 | 500 | $0.0135 |
| Step 0 dispatch | Sonnet → child | — | — | — |
| Child plan | (local, free) | 1,500 | 300 | $0.00 |
| Child step 0 | local executor | 3,000 | 2,000 | $0.00 |
| Child synthesize | (local, free) | 1,000 | 500 | $0.00 |
| Root step 0 result roll-up | — | — | — | $0.00 |
| Root synthesize | Sonnet | 1,500 | 800 | $0.0165 |
| **Total** | | **9,000** | **4,100** | **$0.03** |

Budget remaining after turn: $2.00 − $0.03 = $1.97.

---

## 5. Failure Modes

### 5.1 Depth Exceeded

| Field | Value |
|-------|-------|
| **Trigger** | `parent_depth + 1 > max_depth` (or `> verdict.max_recursion_depth`) |
| **Error code** | `recursion_depth_exceeded` |
| **ExecutorResult.status** | `'recursion_depth_exceeded'` |
| **User-facing message** | `"This task requires deeper recursion than allowed (depth {current}/{max}). The executor's result will be used as-is without further sub-orchestration."` |
| **Trace entry** | Event type `child_orchestration_failed`, data: `{ reason: 'depth_exceeded', parent_depth, max_depth, parent_model, child_model }` |
| **Recovery** | The parent step gets a failed `ExecutorResult`. The orchestrator continues with remaining steps — the depth failure does not abort the entire plan. The synthesis phase sees the failure and can explain it to the user. |

### 5.2 Loop Detected

| Field | Value |
|-------|-------|
| **Trigger** | Edge `(parent_model, child_model, instruction_hash)` already exists in the turn's edge set |
| **Error code** | `loop_detected` |
| **ExecutorResult.status** | `'loop_detected'` |
| **User-facing message** | `"Detected a recursive loop: {parent_model} → {child_model} with the same instruction was already attempted this turn. Aborting to prevent infinite recursion."` |
| **Trace entry** | Event type `child_orchestration_failed`, data: `{ reason: 'loop_detected', edge_key, attempt_number }` |
| **Recovery** | Same as depth exceeded — step fails, plan continues, synthesis reports it. |

### 5.3 Child Budget Starvation

| Field | Value |
|-------|-------|
| **Trigger** | Child's `BudgetGuard.preCheck()` fails because `parent_budget_remaining_usd` was too low for the child's first LLM call, or the child exhausts budget mid-plan |
| **Error code** | `budget_exceeded` |
| **ExecutorResult.status** | `'budget_exceeded'` |
| **User-facing message** | `"The sub-task ran out of budget ($\{spent} of $\{ceiling} used). Partial results may be available."` |
| **Trace entry** | Event type `child_orchestration_failed`, data: `{ reason: 'budget_starvation', child_ceiling, child_spent, parent_remaining_before }` |
| **Recovery** | The child returns whatever partial results it produced. The parent rolls up the child's partial cost. The parent's remaining budget is reduced accordingly. If the partial result is usable, synthesis can incorporate it. |

### 5.4 Model Affinity Violation

| Field | Value |
|-------|-------|
| **Trigger** | `child_model === parent_model && !allow_same_model_recursion` |
| **Error code** | `model_affinity_violation` |
| **ExecutorResult.status** | `'model_affinity_violation'` |
| **User-facing message** | `"Sub-orchestration requires a different model than the parent ({model}). Set allow_same_model_recursion to override."` |
| **Trace entry** | Event type `child_orchestration_failed`, data: `{ reason: 'model_affinity', parent_model, child_model }` |
| **Recovery** | Step fails, plan continues. |

### 5.5 Child Timeout

| Field | Value |
|-------|-------|
| **Trigger** | Child's wall-clock time exceeds `parent_timeout_remaining_ms` |
| **Error code** | `timeout` |
| **ExecutorResult.status** | `'timeout'` |
| **User-facing message** | `"The sub-task timed out after {elapsed}ms (inherited timeout: {ceiling}ms)."` |
| **Trace entry** | Event type `child_orchestration_failed`, data: `{ reason: 'timeout', elapsed_ms, timeout_ceiling_ms }` |
| **Recovery** | Same as budget starvation — partial cost is rolled up, partial results returned if available. |

---

## 6. Worked Examples

### 6.1 API → Local → API

**Scenario**: User asks "Research the top 5 competitors of Acme Corp and write a one-page analysis." The orchestrator (Sonnet) plans two steps: (1) a research step on a local model to gather raw data cheaply, and (2) a writing step on Sonnet itself to produce the polished output.

The research step requests sub-orchestration because the local model needs to break its work into sub-steps (search, extract, summarize).

**Config**:
- Orchestrator model: `anthropic/claude-sonnet-4-6` ($3/$15 per MTok)
- Local executor: `ollama/qwen2.5:32b` (free)
- Budget ceiling: $2.00

**Execution trace**:

```
Turn depth=0, model=sonnet
├─ [plan] sonnet: 2,200 in / 400 out → $0.0126
├─ step 0: sub-orchestrate → local orchestrator
│  │  Turn depth=1, model=qwen2.5:32b
│  ├─ [plan] qwen: 1,800 in / 350 out → $0.00
│  ├─ step 0: [search] qwen executor: 4,000 in / 3,000 out → $0.00
│  ├─ step 1: [extract] qwen executor: 5,000 in / 2,000 out → $0.00
│  ├─ [synthesize] qwen: 2,500 in / 800 out → $0.00
│  └─ child total: 13,300 in / 6,150 out, $0.00, 4.2s
│  cost roll-up to parent: $0.00
├─ step 1: [write analysis] sonnet executor: 3,500 in / 2,000 out → $0.0405
├─ [synthesize] sonnet: 1,200 in / 600 out → $0.0126
└─ root total: 6,900 in / 3,000 out (sonnet) + 13,300 in / 6,150 out (local)
   Combined: 20,200 in / 9,150 out, $0.0657, ~8.5s
```

Budget remaining: $2.00 − $0.0657 = $1.9343.

**Key observations**:
- The local sub-orchestration cost $0 but produced 19,450 tokens of work.
- The API cost is dominated by the writing step ($0.04) and synthesis ($0.01).
- Without recursion, the research would have been done by Sonnet at ~$0.20 — a 3× cost reduction.

### 6.2 Local → API → Local

**Scenario**: User asks "Refactor this 200-line function into smaller functions with tests." A local orchestrator (qwen2.5:32b) decomposes the work. One step — writing the test strategy — needs frontier reasoning, so it sub-orchestrates to Sonnet. Sonnet returns the test plan, and the local model generates the actual test code.

**Config**:
- Orchestrator model: `ollama/qwen2.5:32b` (free)
- API executor: `anthropic/claude-sonnet-4-6` ($3/$15 per MTok)
- Budget ceiling: $1.00

**Execution trace**:

```
Turn depth=0, model=qwen2.5:32b
├─ [plan] qwen: 3,000 in / 500 out → $0.00
├─ step 0: [decompose functions] qwen executor: 6,000 in / 4,000 out → $0.00
├─ step 1: sub-orchestrate → sonnet for test strategy
│  │  Turn depth=1, model=sonnet
│  ├─ [plan] sonnet: 2,000 in / 300 out → $0.0105
│  ├─ step 0: [write test strategy] sonnet executor: 3,000 in / 1,500 out → $0.0315
│  ├─ [synthesize] sonnet: 1,000 in / 400 out → $0.009
│  └─ child total: 6,000 in / 2,200 out, $0.051, 3.8s
│  cost roll-up to parent: $0.051
├─ step 2: [generate test code] qwen executor: 5,000 in / 6,000 out → $0.00
│  (depends_on: [0, 1], input_from: 1)
├─ [synthesize] qwen: 2,000 in / 1,000 out → $0.00
└─ root total: 16,000 in / 11,500 out (local) + 6,000 in / 2,200 out (sonnet)
   Combined: 22,000 in / 13,700 out, $0.051, ~12.1s
```

Budget remaining: $1.00 − $0.051 = $0.949.

**Key observations**:
- Only the test-strategy step hit the API ($0.051). All code generation ran locally for free.
- Step 2 depends on both step 0 (decomposed functions) and step 1 (test strategy from Sonnet). The topological sort in `executePlan()` handles this naturally.
- If Sonnet had been used for everything: ~35,000 tokens at ~$0.20. Recursion saved ~75%.

---

## 7. Decision Table: Where Recursion Checks Fire

The recursion guard runs at **two** points in the pipeline. Both are necessary for different reasons.

| Check point | Location | What fires | Why |
|-------------|----------|-----------|-----|
| **Plan validation** | `OrchestratorLoop.validatePlan()` | Policy checks only: `recursion_disabled`, `max_recursion_depth` | Fail-fast before any dispatch. If policy forbids recursion globally, don't even attempt it. Drops steps with `sub_orchestrate` when policy disallows. No instruction hash available yet (the instruction hasn't been finalized with input data from prior steps). |
| **Dispatch-time** | `ExecutorDispatcher.dispatch()` → calls `RecursionGuard.preCheck()` | Full check: depth, model affinity, budget, loop detection, policy | The authoritative gate. At dispatch time we have the finalized instruction (with `input_from` data injected), the parent's actual remaining budget (which may have changed if sibling steps ran first), and the real parent model string. Loop detection requires the instruction hash, which is only meaningful with the final instruction. |

### Why both?

**Plan-time only** would be insufficient because:
- Budget and timeout are dynamic — sibling steps that run before the recursive step change the remaining budget.
- The instruction may incorporate results from prior steps (`input_from`), so the loop-detection hash computed at plan time would be wrong.

**Dispatch-time only** would be insufficient because:
- If policy disables recursion, we'd still waste an orchestrator planning call producing a plan with sub-orchestration steps, only to reject them one by one at dispatch. Plan-time validation avoids this waste.

### Flow through the code

```
processMessage()
  │
  ├─ getOrchestratorPlan()     → plan may include sub_orchestrate steps
  │
  ├─ validatePlan(plan, verdict)
  │   └─ if verdict.recursion_disabled: strip all sub_orchestrate steps
  │   └─ if depth would exceed verdict.max_recursion_depth: strip those steps
  │
  ├─ executePlan(plan, verdict, recursionGuard)
  │   └─ for each step with sub_orchestrate:
  │       ├─ build ExecutorTask with orchestration field
  │       └─ dispatcher.dispatch(task)
  │           └─ if task.orchestration.allow_sub_orchestration:
  │               ├─ recursionGuard.preCheck(…) → pass/fail
  │               ├─ if pass: spawn child OrchestratorLoop
  │               ├─ collect child result
  │               ├─ roll up cost
  │               └─ write trace edge
  │
  └─ synthesize()
```

---

## 8. Integration Points Summary

| File | Change type | Description |
|------|------------|-------------|
| `src/executor/types.ts` | Modify | Add `orchestration?` to `ExecutorTask`, `sub_orchestration?` to `ExecutorResult`, new status literals, `sub_orchestrate?` to `PlanStep`, extend `ORCHESTRATOR_PLAN_SCHEMA` |
| `src/auth/policy.ts` | Modify | Add `max_recursion_depth?` and `recursion_disabled?` to `PolicyVerdict` and `DEFAULT_POLICY_VERDICT` |
| `src/orchestrator/recursion.ts` | New | `RecursionGuard` class: pre-check, edge registration, loop detection, hash computation |
| `src/orchestrator/prompts.ts` | Modify | Add `writeChildSystemPrompt(parentModel, childModel, instruction)` — deterministic template mode by default |
| `src/orchestrator/loop.ts` | Modify | Create `RecursionGuard` per turn; pass to `executePlan`; in plan validation, strip disallowed sub-orchestrate steps; in execution, detect sub-orchestrate steps and route through `RecursionGuard` → child `OrchestratorLoop` |
| `src/executor/dispatch.ts` | Modify | When `task.orchestration?.allow_sub_orchestration` is true and pre-check passes, instantiate child `OrchestratorLoop` instead of making a direct LLM call |
| `src/trace/types.ts` | Modify | Add `child_orchestration_*` event types and recursion fields to `TraceEventData` |
| `src/trace/logger.ts` | Modify | Add `parent_task_id` and `depth` to event logging; add `formatTraceTree()` for tree-shaped output |

---

## 9. Defaults and Safety Posture

- `allow_sub_orchestration`: **false** everywhere by default. Opt-in per skill manifest and per executor config.
- `max_depth`: **2** default, **4** hard cap. The hard cap is a constant, not configurable.
- `allow_same_model_recursion`: **false** default. Only needed for critic-pass patterns (same model, different system prompt).
- Loop detection scope: **one user turn**. Discarded after `processMessage()` returns.
- Kill switch: `/alduin recursion off` sets `verdict.recursion_disabled = true` for the session. Overrides all skill manifests. Surfaced in `alduin doctor` output.
- `alduin doctor` reports which skills have `allow_sub_orchestration: true` and on what model pairs, so operators can audit the recursion surface.
