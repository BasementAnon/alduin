# Alduin Concepts: Orchestrator, Classifier, Executor

> **New to the architecture?** This page explains the three runtime roles before
> you configure model assignments. If you want the deep dive, see
> [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Quick ASCII flow

```
user message
     │
     ▼
┌───────────────┐   cheap, fast
│  Classifier   │──────────────────────────────────────────▶ skip orchestrator
│ (pre-router)  │                                            (simple tasks)
└───────┬───────┘
        │ complex tasks
        ▼
┌───────────────┐   structured JSON plan
│ Orchestrator  │─────────────────────────────────��────────▶ Executor(s)
│  (planner)    │        (may recurse)                         (doers)
└───────────────┘                                                  │
                                                                   ▼
                                                              Renderer
                                                          (sends reply to user)
```

---

## The Orchestrator

**Thinks but never does.**

The Orchestrator reads your message and the task context, then emits a
structured JSON plan — a list of steps for one or more Executors to carry out.
It never writes files, calls APIs, or sends replies directly. This separation
means the planning model can focus entirely on reasoning without being tempted to
skip steps.

The Orchestrator can **recurse**: it may spawn a child Orchestrator with a
cheaper model to handle a sub-problem, then fold the result back into the parent
plan. A configurable depth guard (default: 3) prevents runaway recursion.

**Example:** the user says "summarize today's emails and draft three replies".
The Orchestrator plans:
1. `email_read` — fetch today's inbox (Executor: `quick`)
2. `summarize` — condense the threads (Executor: `content`)
3. `draft_replies` × 3 — write each reply (Executor: `content`)

---

## The Classifier (pre-classifier)

**Routes messages cheaply before the Orchestrator sees them.**

Most messages are straightforward lookups — "what's on my calendar tomorrow?",
"what time is it in Tokyo?". Sending them through the full Orchestrator would be
wasteful. The Classifier reads the raw message (no conversation history, no
context) and answers one question: *does this need the Orchestrator, or can a
single Executor handle it directly?*

When the Classifier decides a task is simple (confidence above
`routing.complexity_threshold`), Alduin dispatches it straight to the most
appropriate Executor, bypassing planning entirely.

**Why it matters for you:** assign the cheapest, fastest model here. The
Classifier sees only a short prompt and emits a small JSON verdict. Even a
sub-cent model like Claude Haiku or GPT-4.1-mini is ideal — the cost saving
across thousands of messages adds up quickly.

**Example:** "What's on my calendar today?" → Classifier scores it `low
complexity` → dispatched directly to the `quick` Executor → answer in one LLM
call, fraction of a cent.

---

## The Executor

**Does one thing, knows nothing about the conversation.**

Executors receive a single scoped task from the Orchestrator (or directly from
the Classifier) and execute it with no conversation history. This deliberate
amnesia means:

- Each executor call is deterministic and easy to retry in isolation.
- A compromised or hallucinating executor cannot corrupt the session context.
- You can assign different models to different executor *roles* (code, research,
  content, quick) so each role uses the best-fit model for its workload.

**Example:** the `code` Executor gets the task "write a Python function that
parses ISO-8601 timestamps". It has access to the `file_write` and `bash` tools
but cannot see the broader conversation about why you need that function.

---

## Why they're separate

| Concern | Who owns it |
|---------|------------|
| "What should I do?" (planning) | Orchestrator |
| "Is planning even necessary?" (routing) | Classifier |
| "How do I do this one thing?" (execution) | Executor |
| Conversation history | Orchestrator only |
| Tool access | Executors only |

Keeping these concerns separate means you can scale each tier independently,
assign different models per tier, and replace any one layer without touching the
others.

---

## Practical guidance for model assignment

During `alduin init` Step 3, you'll assign a model to each role. Here's a
quick heuristic:

| Role | Priority | Good candidates |
|------|----------|-----------------|
| Orchestrator | Most capable | Claude Sonnet, GPT-4.1 |
| Classifier | Cheapest/fastest | Claude Haiku, GPT-4.1-mini |
| Code executor | Strong at code | Claude Sonnet, GPT-4.1 |
| Research executor | Balanced | Claude Sonnet, GPT-4.1 |
| Content executor | Balanced | Claude Sonnet, GPT-4.1 |
| Quick executor | Cheapest | Claude Haiku, GPT-4.1-mini |

---

*For the full system design — session resolver, ingestion pipeline, memory
tiers, plugin host, policy engine, audit log — see [ARCHITECTURE.md](ARCHITECTURE.md).*

---
*Last reviewed: 2026-04-25*
