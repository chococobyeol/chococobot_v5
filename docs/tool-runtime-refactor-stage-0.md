# Contract-first tool runtime refactor: Stage 0 decision log

Stage 0 records the refactor contract before code moves. The chosen approach is staged and contract-first: define the AI/runtime boundary, lock the expected evidence, then refactor runtime behavior in later stages without changing semantic ownership.

## Decision

Use a staged contract-first refactor.

- Start with documentation and evidence expectations before implementation changes.
- Treat AI output as the source of semantic decisions.
- Keep runtime checks deterministic: structure, safety, permissions, limits, tool state, and exact quoted evidence.
- Preserve existing behavior until a later stage proves an equivalent contract with tests and diagnostics.

## Rejected alternatives

- Feature-first slices: rejected because adding new tool behavior before the contract is stable can hide semantic routing decisions inside runtime code.
- Big-bang replacement: rejected because replacing the tool runtime in one step makes regressions harder to isolate and weakens evidence for AI/runtime boundary preservation.

## Guardrail constraints

This refactor follows `docs/ai-routing-guardrails.md`.

- Code may parse command syntax, validate permissions, enforce bounds, check required JSON fields, persist `pendingAction`, and apply deterministic loop guards from tool state.
- Code must not use keyword or regex classifiers to decide user intent, web-search need, cleanup target meaning, confirmation meaning, or ambiguity wording.
- Web-search routing must come from the agent choosing `web.search` or returning a structured unavailable outcome such as `web_search_unavailable`.
- Clarification text for semantic ambiguity belongs in the AI contract; runtime code only blocks unsafe execution.
- New semantic decisions require a structured AI field or outcome, prompt instructions, persisted slot state when needed, contract/safety validation in code, and regression coverage against prose classifiers.

## Stage 0 evidence expectations

Stage 0 combines a decision log with behavior-lock tests. Evidence should show that later implementation stages keep the contract intact without changing direct prefix-command behavior.

- Contract notes identify which decisions belong to AI output and which checks remain runtime-owned.
- Planned tests cover deterministic runtime validation without adding prose classifiers.
- Diagnostics show tool calls, observations, loop guards, unavailable outcomes, and final answers without leaking raw web observations beyond the intended summaries.
- Regression evidence includes the existing AI routing guardrail tests and targeted runtime tests for `web.search`, `history.search`, `pendingAction`, structured tool calls, and `confirm_pending` paths when those areas are touched.
- This stage reports changed files, targeted tests run, and remaining gaps separately from later implementation-stage evidence.
