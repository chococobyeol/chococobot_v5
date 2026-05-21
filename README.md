# ChococoBot v5

Node.js/TypeScript Discord bot for Korean `!` prefix chat cleanup and voice TTS, designed around Discord's current DAVE/E2EE voice requirement.

## Features

- `!청소 [개수]` / `!clean [count]` — delete the invoking user's recent messages. Default target: 500.
- `!대청소 [개수]` / `!purge [count]` — manage-messages cleanup for recent channel messages. Default target: 1000.
- `!들어와`, `!나가` — join or leave the caller's voice channel.
- `!말 <내용>` / `!say <text>` — enqueue TTS in the current guild voice session.
- `!tts채널 [#채널]` — set the current or named text channel used for auto-read.
- `!tts채널 현재` / `!tts채널 해제` — show or clear the stored auto-read channel.
- `!음색` / `!voice` — list or select supported TTS voice presets.
- `!tts엔진` / `!engine` — list or select your TTS engine (`edge` or `gtts`).
- Bot activity logs are written to the dedicated log server configured by `LOGGING_GUILD_ID`.

Slash-command registration is disabled for the v1 prefix bot path so servers do not get slash-command clutter.

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
| `DISCORD_CLIENT_ID` | _(empty)_ | Only needed if a legacy slash-command registration path is re-enabled. |
| `DISCORD_GUILD_ID` | _(empty)_ | Optional guild ID for legacy slash-command registration. |
| `DATABASE_PATH` | `data/chococobot.sqlite3` | SQLite path for bot state. Use a persistent path such as `/var/data/chococobot.sqlite3` on Render. |
| `LOGGING_GUILD_ID` | `1507058598423826533` | Dedicated Discord server for bot activity logs and test channels. |
| `CLEAN_MINE_DEFAULT_TARGET` | `500` | Default target count for `!청소` when no number is provided. |
| `CLEAN_MINE_MAX_LIMIT` | `500` | Maximum accepted target count for own-message cleanup. |
| `CLEAN_ALL_DEFAULT_TARGET` | `1000` | Default target count for `!대청소` when no number is provided. |
| `CLEAN_ALL_MAX_LIMIT` | `1000` | Maximum accepted target count for admin cleanup. |
| `TTS_VOICE` | `ko-KR-SunHiNeural` | Default Edge TTS voice. |
| `TTS_ENGINE` | `edge` | Default TTS engine when a user has not selected one. |
| `TTS_MAX_CHARS` | `180` | Maximum text length sent to TTS. |
| `TTS_READ_BOT_MESSAGES` | `false` | Whether watched-channel TTS should read bot-authored messages. |
| `LOG_LEVEL` | `info` | Logging verbosity label. |

Deferred AI/Groq variables (`GROQ_API_KEY`, `GROQ_MODEL`, `AI_*`) remain in `.env.example` for compatibility, but they are not required for the cleanup/TTS v1 startup path.

## Cleanup behavior and Discord limits

The 500/1000 cleanup values are target counts, not a single Discord API request. Discord bulk delete accepts at most 100 messages per request and skips/rejects messages older than 14 days, so large cleanup runs must fetch and delete in batches of 100 or fewer while reporting the actual deleted count. The configured max values cap user input; they do not guarantee that Discord will allow every targeted message to be deleted.

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
- `!tts엔진 edge` / `!tts엔진 gtts` stores the TTS engine for that user.
- Aliases such as `!tts엔진 엣지`, `!tts엔진 구글`, and `!tts엔진 google` are also accepted.
- `!tts엔진 해제` clears the stored engine and falls back to `TTS_ENGINE`.
- TTS synthesis does not fall back to another engine automatically; if the selected engine fails, the bot logs the error and stays silent.
- The first TTS request auto-installs the Python package for the selected engine if it is missing.

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

## Render deployment

Use a Render **Background Worker** for the Discord gateway process (no public HTTP server is required).

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Instance type: Starter or larger
- Required secret: `DISCORD_TOKEN`
- Recommended persistent disk path for SQLite: `/var/data/chococobot.sqlite3`

This repo includes an optional `render.yaml` Blueprint. Render Blueprints support `type: worker`, `runtime: node`, `plan: starter`, `buildCommand`, `startCommand`, persistent disks, and `envVars` where secrets can be marked `sync: false` so Render prompts for them in the dashboard.

## Verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
```
