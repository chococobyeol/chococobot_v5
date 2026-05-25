# AI routing guardrails

ChococoBot uses AI to judge user intent. Runtime code may validate safety, permissions, syntax, limits, and exact quoted evidence, but it must not re-interpret natural-language meaning with keyword or regex classifiers.

## Allowed in code

- Prefix and command-name parsing for existing command syntax.
- Permission checks, confirmation storage/consumption, rate limits, count bounds, and Discord API constraints.
- Exact structural checks on AI output, such as required JSON fields, persisted `pendingAction` slots, tarot card-number bounds, active tarot session ownership, or whether a quoted `cleanupEvidence` appears verbatim in the current/prior user text.
- Deterministic execution of a stored pending command after the AI has chosen `confirm_pending`.
- Deterministic loop guards based on tool state, for example refusing to execute another `web.search` after a successful `web.search` observation in the same agent run and asking the AI to answer from existing observations.
- Safe fallback text based only on already collected tool observations, such as returning source URLs when a web-search run reaches the loop limit before the AI produces a final answer.
- Deterministic confirmation copy selected from an already classified command or tool confirmation payload. For example, cleanup confirmations may use fixed safe text after the AI/tool path has already produced `command.cleanup` or `command.mass_cleanup`.
- Safety validation of AI-generated user-facing copy, such as rejecting empty text, JSON, leaked confirmation tokens, or text that is not shaped like a confirmation question. This validates the AI output format/safety; it must not choose the user's intent.
- Structural loop guards on AI envelopes, such as retrying a `blocked` response whose `blockedTools` field is empty. The retry should ask for a structured tool call, a tool-backed block, or `not_handled`; it must not infer the user's intent from prose.

## Not allowed in code

- Keyword/regex functions that decide user intent, such as whether a reply means “yes,” whether a history request is summary vs lookup, or whether a cleanup target means self/other/channel.
- Keyword/regex functions that decide whether a prompt requires web search. Web-search routing must come from the agent choosing `web.search` or returning a structured `unavailable` reason such as `web_search_unavailable`.
- Fallback routers that override an AI `chat`/`not_handled` decision by scanning prose for words like “요약,” “찾아,” “그래,” or “내꺼.”
- Fallbacks that invent factual answers after a web search failed, looped, or produced no usable observation.
- Hard-coded clarification text for semantic ambiguity. The AI should generate the clarify message; code only enforces that unsafe execution does not happen.
- Regex guards over AI or user prose that decide a semantic route such as “this is a permission problem,” “this is a cleanup request,” or “this should be web search.” Use structured fields/observations instead, for example `blockedTools`, tool names, policy, and confirmation payloads.

## Required pattern for new semantic decisions

1. Add a structured AI field or outcome, for example `confirm_pending`, `cleanupTarget`, or `pendingAction`.
2. Put the semantic instruction in the AI prompt.
3. Persist multi-turn slot state from AI output when clarification is needed; do not rebuild the slot values with keyword parsing.
4. Validate only the contract/safety boundary in code.
5. Add a regression test proving code does not contain a prose classifier for that decision.

For tarot/fortune features, code may validate `tarot.start_reading` and `tarot.reveal_selection` fields, active sessions, and card-number constraints, but must not add helpers such as `isTarotIntent`, `mentionsTarot`, or `isFortunePrompt`.

If a future change feels like it needs `isSomethingIntent(...)`, stop and move that decision into the AI contract instead.
