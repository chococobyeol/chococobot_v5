# Tool Authoring Guide

This guide defines the contract for adding future AI-routed tools without growing the
system prompt or rebuilding natural-language routing in TypeScript. A tool is the
source of truth for its policy, schema, validation, confirmation needs, execution
adapter, observation shape, and required tests.

## 1. When to create a tool

Create a tool when the assistant needs deterministic access to repository-owned or
bot-owned capabilities: reading time/history/search data, joining voice, speaking,
changing settings, cleanup, or any operation that must be logged, validated, blocked,
or confirmed before execution.

Do not create a tool for ordinary chat, style-only answers, or decisions that can be
answered from the current conversation without external state. Do not add prompt-only
behavior for a capability that requires validation, permission checks, or side effects.

## 2. Tool naming and purpose

Use stable dotted names in `domain.action` form, such as `history.search`,
`voice.speak`, `settings.prefix`, or `memory.delete`. The name must describe one
bounded operation, not a broad natural-language classifier. Tool descriptions should
help the model choose the tool, while code must validate the exact structured fields.

Avoid names that imply hidden command conversion, such as `routeUserIntent` or
`runAnyCommand`. If compatibility with direct prefix syntax is needed, keep it behind
an explicit compatibility bridge and document its retirement condition.

## 3. Policy selection

Choose the least-permissive policy that still matches current product behavior.

| Policy | Use when | Runtime expectation |
| --- | --- | --- |
| `read_only_auto` | The tool only reads state or fetches information. | Runtime may execute automatically after schema validation and should suppress repeated successful read-only calls. |
| `safe_action_auto` | The tool performs a reversible/low-risk action currently allowed without confirmation, such as voice join/leave/speak. | Runtime may execute automatically after validation and adapter preconditions. |
| `confirmation_required` | The tool changes settings, deletes data, performs cleanup, or otherwise needs user confirmation and/or admin checks. | Registry returns a `confirmation_required` observation instead of executing. |
| `blocked` / compatibility-only policies | The automatic loop must not execute the tool. | Runtime returns a structured block and the assistant explains the safe path. |

When admin permission is required, enforce it before execution or before creating an
executable confirmation. A missing admin permission should become a structured blocked
observation, not a best-effort command string.

## 4. Input schema and required fields

Every tool needs a compact `inputSchema` and a validator. Prefer explicit required
fields and small enums over prose rules. Examples:

- `voice.speak`: `{ text: string }`, with a non-empty text length bound.
- `command.cleanup`: `{ target: 'self', count: number, evidence: string }`.
- `settings.prefix`: `{ action: 'set' | 'reset', prefix?: string }`.

Validation must reject missing, ambiguous, out-of-bounds, or wrongly typed fields. The
AI may clarify or retry with corrected structured input; code must not infer omitted
semantic intent by scanning arbitrary user prose.

## 5. Validation error code/field/hint pattern

Validation failures must return observations with:

- `status: 'error'`
- `code: 'validation_error'` or a more specific stable code
- `field` when one field caused the failure
- `message` for concise diagnostics
- `hint` telling the model how to fix the structured input

Hints should name the field and the schema expectation, for example: “Fix `count` to a
number between 1 and 500, then retry only if cleanup is still needed.” Avoid vague
errors such as “bad request” or “could not understand.”

## 6. Confirmation and admin pattern

Destructive or admin-only tools return `status: 'confirmation_required'` with a
`confirmation` payload that includes:

- `intent`: the tool name or stable action identifier
- `preview`: user-visible summary of the proposed action
- `payload`: the validated structured input
- `commandQuery` only when a direct prefix compatibility path is intentionally used
- `expiresAt` when the confirmation has a deadline

The runtime should ask the user to confirm from this structured payload. Confirmation
approval must be selected by the AI as a structured confirmation outcome such as
`confirm_pending`; code must not parse arbitrary “yes/ok/do it” prose on its own.

## 7. Observation output rules

All tool results must use the common observation shape:

```ts
{
  callId: string;
  toolName: string;
  status: 'ok' | 'error' | 'blocked' | 'confirmation_required';
  policy: AgentToolPolicy;
  code?: string;
  field?: string;
  message?: string;
  hint?: string;
  output?: unknown;
  error?: string;
  confirmation?: ConfirmationPayload;
}
```

Successful observations should include compact `output` values that are enough for the
assistant to answer. Error and blocked observations should be safe to show or summarize
without exposing provider internals, secrets, or stack traces.

## 8. Runtime loop expectations

The runtime owns the loop contract:

1. Ask the model for one JSON envelope.
2. Validate tool calls against registered names and schemas.
3. Execute only policies that are safe for automatic execution.
4. Return structured observations for validation, policy, confirmation, and adapter
   failures.
5. Suppress repeated successful read-only calls with the same purpose/input.
6. Produce a final answer from observations instead of looping or falling back to
   `not_handled` after useful tool evidence exists.

A tool must not require extra system-prompt exception paragraphs to work. Put the
contract in the tool definition, validator, policy, and tests.

## 9. Required tests for new tools

Add tests before or with each new tool:

- Registry contract tests for schema validation, `code`/`field`/`hint`, policy, and
  confirmation observation shape.
- Runtime tests proving the AI-routed request uses the structured tool path and that
  final answers are grounded in observations.
- Safety tests for admin/confirmation blocks and adapter preconditions.
- Prompt contract tests if a change risks reintroducing tool-specific prompt bloat.
- Legacy retirement tests when migrating an old direct command: the migrated AI-routed
  path must use structured tool calls or confirmation observations, never fallback
  command conversion.
- Guardrail tests proving no new prose semantic parser or hidden natural-language
  classifier was added.

Run the focused tests for the touched tool family, then the shared validation gate:
`npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` before final
acceptance.

## 10. Anti-patterns

Do not add:

- Prompt-only tool behavior that is not backed by schema, policy, and tests.
- Prose keyword classifiers such as `isVoiceIntent`, `mentionsCleanupTarget`, or
  hidden regex routers for natural-language meaning.
- Vague validation errors without stable `code`, `field`, and `hint` data.
- Unbounded retries after a successful observation or repeated validation failure.
- Hidden fallback command conversion where arbitrary AI-routed requests are converted
  to direct prefix commands.
- Tool adapters that leak stack traces, secrets, provider internals, or oversized data
  into observations.

Future tools should make the common runtime contract stronger and the prompt shorter.
If a feature needs a long exception paragraph, the tool contract is not yet explicit
enough.
