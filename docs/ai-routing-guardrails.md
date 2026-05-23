# AI routing guardrails

ChococoBot uses AI to judge user intent. Runtime code may validate safety, permissions, syntax, limits, and exact quoted evidence, but it must not re-interpret natural-language meaning with keyword or regex classifiers.

## Allowed in code

- Prefix and command-name parsing for existing command syntax.
- Permission checks, confirmation storage/consumption, rate limits, count bounds, and Discord API constraints.
- Exact structural checks on AI output, such as required JSON fields or whether a quoted `cleanupEvidence` appears verbatim in the current/prior user text.
- Deterministic execution of a command after the AI has chosen `legacy_command` or `confirm_pending`.

## Not allowed in code

- Keyword/regex functions that decide user intent, such as whether a reply means “yes,” whether a history request is summary vs lookup, or whether a cleanup target means self/other/channel.
- Fallback routers that override an AI `chat`/`not_handled` decision by scanning prose for words like “요약,” “찾아,” “그래,” or “내꺼.”
- Hard-coded clarification text for semantic ambiguity. The AI should generate the clarify message; code only enforces that unsafe execution does not happen.

## Required pattern for new semantic decisions

1. Add a structured AI field or outcome, for example `confirm_pending` or `cleanupTarget`.
2. Put the semantic instruction in the AI prompt.
3. Validate only the contract/safety boundary in code.
4. Add a regression test proving code does not contain a prose classifier for that decision.

If a future change feels like it needs `isSomethingIntent(...)`, stop and move that decision into the AI contract instead.
