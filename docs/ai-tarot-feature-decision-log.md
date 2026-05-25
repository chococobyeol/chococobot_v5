# AI tarot feature decision log

Date: 2026-05-25

## Decision

ChococoBot adds tarot/fortune as an AI-routed Discord chat feature on the existing `!?` / AI-channel path. The AI decides whether the user is asking for tarot or a similar fortune reading, chooses an appropriate 1-5 card spread, and writes the final interpretation. TypeScript code only validates structured tool fields, card selection safety, active session ownership, and Discord rendering metadata.

## Evidence and constraints

- Product scope from the interview: Discord chat output only; no broadcast overlay, no TTS voice, no admin UI, no stream-platform integration, no quota/cooldown.
- Reference repo: `https://github.com/chococobyeol/AIsChoco` was reachable during implementation. Its `assets/tarot` images were copied into this repo's `assets/tarot` because the user confirmed they drew the images and allowed reuse.
- Guardrail docs: `docs/ai-routing-guardrails.md` requires AI-owned semantic decisions and forbids TypeScript keyword/regex intent routers.
- Tool guide: `docs/tool-authoring-guide.md` requires bounded dotted tools, compact schemas, policy, validation, observation shape, and tests.

## Implemented shape

- `tarot.start_reading` (`safe_action_auto`) creates a requester/channel scoped session after AI supplies `{ topic, spreadCount, spreadName? }`.
- `tarot.reveal_selection` (`safe_action_auto`) accepts `{ numbers }` and validates active session, exact count, uniqueness, and `1~78` bounds.
- Sessions are in-memory with TTL and are keyed by guild/channel/user. Channel-level active lookup exists only for wrong-requester feedback.
- Card metadata and rendering paths are repo-owned constants under `assets/tarot`; user/AI input cannot supply arbitrary file paths.
- The bot routes non-prefixed numeric follow-ups only when a tarot session already exists, after direct prefix and `!?` handling but before natural-language fallback, AI-channel fallback, or watched-channel TTS.
- Discord output uses built-in `discord.js` embeds and attachments; no new npm dependency was added.

## Rejected alternatives

- Deterministic tarot keyword router (`isTarotIntent`, `mentionsTarot`, etc.): rejected because it violates AI routing guardrails.
- Broadcast-style overlay replication from AIsChoco: rejected because the requested output is Discord chat only.
- New image/chart dependencies: rejected because graph-like summaries can be rendered as text bars and Discord embeds with existing dependencies.
- Consuming sessions on invalid selections: rejected so users can retry after duplicate/out-of-range/wrong-count feedback.

## Verification notes

Focused tests cover deck metadata, session TTL/ownership, tool registry contract, AgentRuntime pending-action continuation and presentation propagation, bot routing/rendering, prompt budget, and semantic guardrails. Final full verification is tracked by the Ultragoal quality gate.
