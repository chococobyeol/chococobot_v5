# ChococoBot v5

Node.js/TypeScript Discord bot for Korean `!` prefix chat cleanup and voice TTS, designed around Discord's current DAVE/E2EE voice requirement.

## Features

- `!청소 [개수]` / `!clean [count]` — delete the invoking user's recent messages. Default target: 500.
- `!대청소 [개수]` / `!purge [count]` — manage-messages cleanup for recent channel messages. Default target: 1000.
- `!들어와`, `!나가` — join or leave the caller's voice channel.
- `!이리와` / `!꺼져` / `!저리가` — aliases for `!들어와` / `!나가`.
- `!말 <내용>` / `!say <text>` / `!speak <text>` — enqueue TTS in the current guild voice session.
- `!멈춰` / `!stop` / `!halt` / `!cancel` / `!pause` — stop the current TTS playback and clear the queue.
- `!tts채널 [#채널]` — set the current or named text channel used for auto-read.
- `!tts채널 현재` / `!tts채널 해제` — show or clear the stored auto-read channel.
- `!ai채널 [#채널]` — set the current or named text channel where ordinary messages are treated as AI chat prompts.
- `!ai채널 현재` / `!ai채널 해제` — show or clear the stored AI chat channel.
- `!웹검색 현재` / `!웹검색 <모드>` — show or change the guild AI web-search mode. Server administrators only for changes.
- `!음색` / `!voice` — list or select supported TTS voice presets.
- `!tts엔진` / `!engine` — list or select your TTS engine (`edge` or `gtts`).
- `!프리픽스` / `!prefix` — show or change the server command prefix. Allowed values: `!`, `?`, `.`, `~`. Server administrators only.
- `!<prefix>? <프롬프트>` — ask Groq AI in-channel, for example `!? 안녕` or `~? 오늘 뭐해`.
- `!도움말` / `!명령어` / `!help` — show the full command list.
- `!기억삭제` / `!ai-memory` — clear the guild-wide AI memory. Server administrators only.
- Bot activity logs are written to the dedicated log server configured by `LOGGING_GUILD_ID`.

## Why Node.js instead of Python here?

Voice TTS is a first-class feature. Since Discord requires DAVE/E2EE-capable clients for non-Stage voice calls, this project uses `discord.js` + `@discordjs/voice` and performs a startup voice dependency diagnostic. Python may work with very recent `discord.py` + `davey`, but this project avoids that risk path.

## Requirements

- Node.js 22 LTS+
- Python 3 (`python3` on PATH) for TTS synthesis
- FFmpeg available; `ffmpeg-static` is included for package-level availability, but system FFmpeg is still recommended.
- Discord bot token.
- Discord Developer Portal: enable **Message Content Intent** for prefix commands and automatic TTS watching.
- Discord bot permissions:
  - Send Messages
  - Read Message History
  - Manage Messages, required for `!대청소` / `!purge`
  - Connect
  - Speak

## Setup

```bash
npm install
cp .env.example .env
# fill DISCORD_TOKEN at minimum
npm run build
npm start
```

For fast local development:

```bash
npm run dev
```

## Environment variables

Required for v1 startup:

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | _(none)_ | Discord bot token. |

Optional v1 settings:

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_PATH` | `data/chococobot.sqlite3` | SQLite path for bot state. On Render this defaults to `/var/data/chococobot.sqlite3` on the container's ephemeral filesystem unless you add a persistent disk. |
| `LOGGING_GUILD_ID` | `1507058598423826533` | Dedicated Discord server for bot activity logs and test channels. |
| `VOICE_IDLE_LEAVE_MS` | `600000` | How long the bot stays in voice after the queue becomes idle before auto-leaving. |
| `PYTHON_BIN` | `python3` | Python executable used for TTS. In the Docker/Render image this is `/app/.venv/bin/python`. |
| `CLEAN_MINE_DEFAULT_TARGET` | `500` | Default target count for `!청소` when no number is provided. |
| `CLEAN_MINE_MAX_LIMIT` | `500` | Maximum accepted target count for own-message cleanup. |
| `CLEAN_ALL_DEFAULT_TARGET` | `1000` | Default target count for `!대청소` when no number is provided. |
| `CLEAN_ALL_MAX_LIMIT` | `1000` | Maximum accepted target count for admin cleanup. |
| `TTS_VOICE` | `ko-KR-SunHiNeural` | Default Edge TTS voice. |
| `TTS_ENGINE` | `edge` | Default TTS engine when a user has not selected one. |
| `TTS_MAX_CHARS` | `500` | Maximum text length sent to TTS. Messages longer than this are rejected with a warning. |
| `TTS_READ_BOT_MESSAGES` | `false` | Whether watched-channel TTS should read bot-authored messages. |
| `AI_MEMORY_RECENT_TURNS` | `8` | How many recent unsummarized AI turns are kept in the live prompt. |
| `AI_MEMORY_COMPACT_AFTER_TURNS` | `12` | When the bot compacts guild AI memory into a summary. |
| `AI_MEMORY_MAX_SUMMARY_CHARS` | `2000` | Maximum stored summary length after compaction. |
| `AI_CONFIRM_OWN_CLEANUP` | `false` | If `true`, AI-routed own-message cleanup (`!청소`) asks for confirmation before deleting. `!대청소` still always requires confirmation/admin checks. |
| `WEB_SEARCH_ENABLED` | `true` | Enables the AI agent's web-search tool. The tool still requires a provider base URL before it can search. |
| `WEB_SEARCH_PROVIDER` | `searxng` | Web-search provider. Currently only `searxng` is implemented. |
| `WEB_SEARCH_BASE_URL` | _(none)_ | Base URL of a SearXNG instance with JSON search enabled. The Docker/Render worker defaults to private loopback `http://127.0.0.1:8888`. The bot calls `/search?q=...&format=json`. |
| `WEB_SEARCH_TIMEOUT_MS` | `5000` | Timeout for one web-search provider request. |
| `WEB_SEARCH_RESULT_COUNT` | `3` | Default number of normalized search results passed to the AI agent. |
| `WEB_SEARCH_DEFAULT_MODE` | `search_first_factual` | Default guild web-search mode: `disabled`, `explicit_only`, `automatic`, or `search_first_factual`. |
| `SEARXNG_PORT` | `8888` | Local-only SearXNG port used by the Docker/Render entrypoint. |
| `SEARXNG_READY_TIMEOUT_SECONDS` | `25` | Startup readiness wait for local SearXNG before the bot starts anyway. |
| `SMOKE_MODE` | _(none)_ | Set to `1` for login-free startup smoke validation; this mode never calls `client.login`. |
| `BOT_TIME_ZONE` | `Asia/Seoul` | Fallback server time zone for features that cannot use Discord's client-local timestamp rendering. Current-time AI replies use Discord timestamp tags instead. |
| `LOG_LEVEL` | `info` | Logging verbosity label. |

Deferred AI/Groq variables (`GROQ_API_KEY`, `GROQ_MODEL`, `AI_*`) remain in `.env.example` for compatibility, but they are not required for the cleanup/TTS v1 startup path.

## Cleanup behavior and Discord limits

The 500/1000 cleanup values are target counts, not a single Discord API request. Discord bulk delete accepts at most 100 messages per request and skips/rejects messages older than 14 days, so large cleanup runs must fetch and delete in batches of 100 or fewer while reporting the actual deleted count. The configured max values cap user input; they do not guarantee that Discord will allow every targeted message to be deleted.

Cleanup commands count backwards from the most recent messages in the channel and **do not count the command message itself**.

- `!청소 N` deletes up to `N` of the invoking user's recent messages that appear before the command message.
- `!대청소 N` deletes up to `N` recent channel messages that appear before the command message.

## TTS voice presets

The starter voice preset map is defined in `src/config.ts`:

- `sunhi` / `bright` → `ko-KR-SunHiNeural`
- `injoon` / `calm` → `ko-KR-InJoonNeural`

`TTS_VOICE` controls the fallback voice when a user has not selected a preset.

## TTS channel behavior

- `!tts채널` stores the current text channel as the guild's auto-read channel.
- `!tts채널 #채널` stores a named text channel as the guild's auto-read channel.
- `!tts채널 현재` shows the stored auto-read channel.
- `!tts채널 해제` clears that guild setting.
- When the watched channel is set and the bot is in voice, messages in that channel are read aloud.
- `!말 <문장>` still speaks an ad-hoc sentence immediately in the current voice session.
- `!말 <문장>` rejects text longer than `TTS_MAX_CHARS` and tells the user the limit.
- If the bot is not already in voice, `!말 <문장>` will join the caller's current voice channel first.
- `!멈춰` / `!stop` / `!halt` / `!cancel` / `!pause` stops the current voice playback and clears queued TTS.
- `!tts엔진 edge` / `!tts엔진 gtts` stores the TTS engine for that user.
- Aliases such as `!tts엔진 엣지`, `!tts엔진 구글`, and `!tts엔진 google` are also accepted.
- `!tts엔진 해제` clears the stored engine and falls back to `TTS_ENGINE`.
- `!시간대 America/Los_Angeles` stores the user's time zone for features that need a concrete IANA time zone; simple AI time replies use Discord timestamp tags so each viewer sees their local time.
- TTS synthesis retries with `gtts` when the selected `edge` engine fails and logs the underlying error.
- Hosted environments that enforce PEP 668 may reject runtime `pip install --user`. `npm install` runs `scripts/setup-python-tts.sh` automatically and creates `.venv`; on Render, set `PYTHON_BIN=/opt/render/project/src/.venv/bin/python` or let the bot auto-detect `.venv/bin/python`.

## AI chat behavior

- Use the current server prefix plus `?` and a space to call AI: `!? 안녕`, `~? 오늘 뭐해`, `.? 설명해줘`.
- `!ai채널` stores the current text channel as the guild's AI chat channel.
- `!ai채널 #채널` stores a named text channel as the guild's AI chat channel.
- `!ai채널 현재` shows the stored AI chat channel.
- `!ai채널 해제` clears that guild setting.
- `!웹검색 현재` shows the guild's AI web-search mode and provider status.
- `!웹검색 disabled|explicit_only|automatic|search_first_factual` changes how eagerly AI chat may call web search.
- `!웹검색 초기화` clears the guild override and falls back to `WEB_SEARCH_DEFAULT_MODE`.
- In the configured AI chat channel, ordinary user messages are handled as AI prompts without `!?`.
- Prefix commands still run as commands in the AI chat channel, so `!도움말`, `!청소`, and `!ai채널 해제` are not sent to AI chat.
- The bot replies in the same channel and does not ping the user by default.
- AI replies are chunked to stay within Discord's message limit.
- Only explicit AI prompts, configured AI-channel prompts, and replies are stored in guild memory; other ordinary chat is not ingested.
- Guild memory is shared across the server and stores user IDs/user names so future replies can keep track of who said what.
- `!기억삭제` / `!ai-memory` clears the guild AI memory and is limited to server administrators.
- Background memory summarization counts against guild AI usage, not the requesting user's quota.

### AI web search

AI chat can call a read-only `web.search` tool when the server mode allows it:

- `disabled` — never search; explicit search requests receive an unavailable-style answer.
- `explicit_only` — search only when the user explicitly asks for web/search/latest/source/fact-checking.
- `automatic` — search when current external facts or uncertainty materially affect the answer.
- `search_first_factual` — default; prefer searching for current, external, or fact-checkable questions.

The current implementation is SearXNG-first and uses Node's built-in `fetch`, so it adds no default npm dependency and no mandatory search API key. In Docker/Render deployments this repo starts a private loopback SearXNG process in the same worker and points `WEB_SEARCH_BASE_URL` at it. Search observations are normalized to short title/URL/snippet records before AI prompts, diagnostics, or short-term agent context use them; raw provider JSON, raw web-search query text, and long result bodies are not logged.

Brave Search is intentionally not enabled by default because it requires an API key/account and a separate provider implementation. It can be added later as an explicit opt-in provider with its own `WEB_SEARCH_PROVIDER` value and key setting.

## Command prefix behavior

- The default command prefix is `!`.
- Each guild can store its own prefix with `!프리픽스` or `!prefix`.
- Only server administrators can change the stored prefix.
- Allowed prefixes are limited to `!`, `?`, `.`, and `~` to avoid collisions with normal chat.
- `!프리픽스 현재` shows the current setting, and `!프리픽스 초기화` restores the default `!`.

## Bot activity logging

The bot writes command and error logs to the dedicated logging server only. General chat contents are not recorded unless they are explicitly sent to TTS by a command such as `!말`.

On startup, the bot ensures the logging server contains:

- `메모채널`
- `봇-채팅-테스트채널`
- `봇-음성-테스트채널`
- one text log channel per server the bot has joined

To reset that server and recreate those channels, run:

```bash
npm run setup:logs
```

The setup script deletes the logging server's existing channels before recreating the standard layout, so use it only for the dedicated log server.

## DAVE/E2EE voice check

On startup the bot prints `@discordjs/voice`'s dependency report and verifies `@snazzah/davey` can be imported. If voice connection fails with `4017`, treat it as a DAVE/E2EE dependency/version problem first.


## Operator-only commands

These commands are intentionally not shown in the public `!도움말` output.

| Command | Scope | Description |
| --- | --- | --- |
| `!로그채널삭제` / `!로그정리` / `!로그삭제` | `LOGGING_GUILD_ID` server only, Discord administrator only | Deletes managed bot log text channels (`LOG-*` or `Source guild:` topic) and clears stored log-channel mappings. Use this only when rebuilding the logging server layout. |

## Render deployment

자세한 Render 호스팅 절차는 [`docs/render-hosting.md`](docs/render-hosting.md)를 참고하세요.

Use exactly one Render **Background Worker** on the Starter plan. The Blueprint now uses `runtime: docker`, so Render builds `Dockerfile` and starts `scripts/render-start.sh` from the image `CMD`. No public HTTP service or second SearXNG service is required.

- Service: one `type: worker`, `plan: starter`, `runtime: docker`
- Required secrets: `DISCORD_TOKEN`, `GROQ_API_KEY` when AI chat is enabled
- SQLite path: `/var/data/chococobot.sqlite3` on the container's ephemeral filesystem by default; add a Render disk only if you want bot settings/memory to survive redeploys
- Local web search: SearXNG runs inside the same container on `127.0.0.1:8888` and is reached through `WEB_SEARCH_BASE_URL=http://127.0.0.1:8888`
- Bot uptime policy: startup waits briefly for SearXNG, but the Discord bot starts even if SearXNG is slow/unavailable; explicit search then fails gracefully instead of taking the bot down.

SearXNG is configured in `config/searxng/settings.yml` with JSON output enabled and no public exposure. `SEARXNG_SECRET` is generated at container start if you do not provide one; it is not a paid provider API key.

For local Docker verification, run:

```bash
scripts/docker-smoke.sh
```

That script builds the image and runs it with `.env.smoke` plus `SMOKE_MODE=1`. Smoke mode validates config and the local SearXNG JSON endpoint without calling `client.login`.

## Verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
```
