# Contract-first tool runtime decision log

Stage 0 locks the behavior contract before any tool-runtime refactor. Internal routing can change later, but user-visible command behavior and the AI/code safety boundary stay stable.

## Decisions

- Keep direct prefix commands on the deterministic command path before AI chat or natural-language routing. This covers cleanup, mass cleanup, voice join/leave, speech, TTS channel settings, prefix settings, and memory deletion commands.
- Agent runtime has no command-conversion output. AI-routed voice, cleanup, settings, web-search settings, and memory actions must use structured tool calls or confirmation observations.
- Preserve cleanup safety by requiring `command.cleanup` / `command.mass_cleanup` structured input and confirmation observations. Do not infer self/channel/other from prose in runtime code, and require cleanup evidence to match actual user/follow-up text before confirmation.
- Keep confirmation decisions in the AI contract through `confirm_pending`; runtime code stores and consumes pending confirmation state but does not classify natural-language approval text itself.
- Route read-only tools only through allowlisted tool policies and observation-based loop guards. A successful observation should be reused instead of repeating the same tool call in the same run.
- Keep web-search availability and failure semantics explicit through `web.search` observations or `web_search_unavailable`; runtime code must not invent a factual fallback after a failed or empty search.

## Migration notes

- The migration is contract-first, not a claim that every existing deterministic helper is gone. Existing command parsing, confirmation storage, channel matching, and history-routing glue can coexist while AI-owned semantic decisions move behind structured contracts.
- `history.search` and `web.search` stay read-only schema contracts; confirmation-only and action tools stay non-auto-executable unless the existing command/confirmation path executes them.
- Planner, natural-language router, and agent runtime paths may coexist during migration. The stable contract is that direct commands preserve current safety branches, while AI-routed migrated behavior uses tool observations/confirmations instead of command conversion.

## Guardrails for the refactor

- Do not add semantic prose classifiers such as `isSomethingIntent(...)`, keyword lists, or regex fallbacks for Korean intent decisions.
- Add or extend structured AI outputs when a new semantic distinction is required, then validate only the safety boundary in code.
- Prefix parity tests should prove existing commands still bypass AI routing and keep their current safety branch behavior.
- Guardrail wording remains anchored in `docs/ai-routing-guardrails.md`; this log records implementation decisions, while that file remains the normative AI-vs-code boundary.
