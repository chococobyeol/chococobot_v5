# Render 호스팅 가이드: ChococoBot + 로컬 SearXNG 단일 Worker 배포

이 문서는 이 레포의 현재 Docker/Render 구성을 기준으로, ChococoBot과 SearXNG를 **Render Starter plan의 Background Worker 1개**로 배포하는 방법을 설명합니다.

현재 구조는 다음과 같습니다.

- Render 서비스는 `render.yaml`의 **단일 `type: worker` 서비스**입니다.
- 서비스 런타임은 `runtime: docker`입니다.
- Render는 repo의 `Dockerfile`을 빌드합니다.
- 컨테이너 안에서 `scripts/render-start.sh`가 실행됩니다.
- `scripts/render-start.sh`는 같은 컨테이너 내부에서 SearXNG를 `127.0.0.1:8888`로 띄우고, 그 다음 Discord 봇을 실행합니다.
- SearXNG는 외부 공개 포트가 없고, 봇만 `WEB_SEARCH_BASE_URL=http://127.0.0.1:8888`로 접근합니다.

참고 문서:

- Render Docker: <https://render.com/docs/docker>
- Render Blueprint spec: <https://render.com/docs/blueprint-spec>
- Render environment variables/secrets: <https://render.com/docs/configure-environment-variables/>
- Render deploys: <https://render.com/docs/deploys>
- SearXNG docs: <https://docs.searxng.org/>

## 1. 배포 전 준비물

필수 준비물은 다음 3개입니다.

1. GitHub에 push된 이 레포
2. Discord Bot Token
3. Groq API Key

선택적으로 확인할 값:

- 로그 전용 Discord 서버 ID: `LOGGING_GUILD_ID`

## 2. GitHub에 최신 코드 push

로컬에서 변경사항을 commit하고 GitHub에 push합니다.

```bash
git status
git add .
git commit -m "Host bot and local SearXNG in one Render worker"
git push origin main
```

커밋 메시지는 프로젝트 규칙상 실제로는 Lore protocol 형식으로 작성하는 것을 권장합니다.

## 3. Render Blueprint로 생성하기

Render Dashboard에서 다음 순서로 진행합니다.

1. <https://dashboard.render.com> 접속
2. 왼쪽 메뉴에서 **Blueprints** 이동
3. **New Blueprint Instance** 클릭
4. GitHub 계정 연결
5. `chococobot_v5` repo 선택
6. branch는 보통 `main` 선택
7. Render가 repo root의 `render.yaml`을 읽는지 확인
8. 생성될 서비스가 아래처럼 보이는지 확인

```yaml
type: worker
name: chococobot-v5
runtime: docker
plan: starter
```

이 값들이 보이면 정상입니다.

## 4. Render가 물어보는 secret 입력

`render.yaml`에는 secret 값이 `sync: false`로 선언되어 있습니다. Render는 Blueprint 최초 생성 시 이 값들을 Dashboard에서 입력하라고 물어봅니다.

입력해야 하는 값:

| Key | 입력값 | 설명 |
| --- | --- | --- |
| `DISCORD_TOKEN` | Discord 봇 토큰 | 봇 로그인에 필요 |
| `GROQ_API_KEY` | Groq API key | AI 답변 생성에 필요 |

### Discord Bot Token 확인 위치

1. <https://discord.com/developers/applications> 접속
2. 봇 Application 선택
3. **Bot** 메뉴 이동
4. Token 복사 또는 Reset Token 후 복사
5. Render의 `DISCORD_TOKEN`에 입력

주의: Discord token은 절대 GitHub에 commit하지 마세요.

### Groq API Key 확인 위치

1. Groq Console에서 API key 생성
2. Render의 `GROQ_API_KEY`에 입력

주의: Groq key도 절대 GitHub에 commit하지 마세요.

## 5. 기본으로 들어간 환경변수

대부분의 값은 `render.yaml`에 이미 들어가 있으므로 직접 입력하지 않아도 됩니다.

| Key | 기본값 | 설명 |
| --- | --- | --- |
| `NODE_ENV` | `production` | production 실행 |
| `PYTHON_BIN` | `/app/.venv/bin/python` | 컨테이너 내부 TTS Python |
| `WEB_SEARCH_ENABLED` | `true` | AI 웹 검색 활성화 |
| `WEB_SEARCH_PROVIDER` | `searxng` | SearXNG provider 사용 |
| `WEB_SEARCH_BASE_URL` | `http://127.0.0.1:8888` | 컨테이너 내부 SearXNG 주소 |
| `WEB_SEARCH_DEFAULT_MODE` | `search_first_factual` | 사실 확인 질문은 검색 우선 |
| `SEARXNG_PORT` | `8888` | 내부 SearXNG port |
| `SEARXNG_READY_TIMEOUT_SECONDS` | `25` | SearXNG readiness 대기 시간 |
| `DATABASE_PATH` | `/var/data/chococobot.sqlite3` | Render persistent disk SQLite 경로 |
| `TTS_ENGINE` | `edge` | 기본 TTS engine |
| `LOG_LEVEL` | `info` | 로그 레벨 |

## 6. LOGGING_GUILD_ID 확인 또는 수정

현재 `render.yaml`에는 기본 로그 서버 ID가 들어 있습니다.

```yaml
LOGGING_GUILD_ID=1507058598423826533
```

이 ID가 실제 로그 전용 Discord 서버 ID와 다르면 Render에서 수정하세요.

수정 방법:

1. Render Dashboard에서 `chococobot-v5` 서비스 선택
2. 왼쪽 **Environment** 메뉴 이동
3. `LOGGING_GUILD_ID` 값 수정
4. **Save, rebuild, and deploy** 선택

Discord 서버 ID 복사 방법:

1. Discord 사용자 설정에서 개발자 모드 활성화
2. 서버 우클릭
3. **서버 ID 복사**

## 7. Blueprint 생성 및 첫 deploy

Secret 입력을 마친 뒤 Blueprint 생성 버튼을 누르면 Render가 자동으로 deploy를 시작합니다.

Render가 수행하는 과정:

1. GitHub repo checkout
2. `Dockerfile` build
3. Node dependencies 설치
4. TypeScript build
5. SearXNG 설치
6. Docker image 생성
7. `CMD ["bash", "./scripts/render-start.sh"]` 실행

## 8. 정상 로그 확인

Render 서비스의 **Logs**에서 다음 로그를 확인합니다.

정상 readiness 예시:

```text
Starting local SearXNG on http://127.0.0.1:8888
SearXNG readiness probe passed.
```

SearXNG가 늦는 경우:

```text
SearXNG did not become ready within 25s; continuing so the bot can stay online without web search.
```

이 경고는 즉시 실패를 의미하지 않습니다. 현재 정책은 **봇 uptime 우선**입니다. SearXNG가 느리거나 일시적으로 죽어도 Discord 봇은 계속 실행됩니다. 다만 웹 검색 요청은 unavailable 응답을 줄 수 있습니다.

## 9. Discord에서 동작 확인

봇이 온라인이 된 뒤 Discord 서버에서 확인합니다.

기본 명령 확인:

```text
!도움말
```

웹 검색 모드 확인:

```text
!웹검색 현재
```

AI 검색 테스트:

```text
!? 오늘 최신 AI 뉴스 검색해줘
```

정상적인 웹 검색 답변은 본문에 `[1]`, `[2]` 같은 인용 번호와 아래쪽 `출처:` 목록이 붙습니다.

## 10. 웹 검색 모드 변경

서버 관리자만 변경할 수 있습니다.

```text
!웹검색 disabled
!웹검색 explicit_only
!웹검색 automatic
!웹검색 search_first_factual
!웹검색 초기화
```

모드 의미:

| Mode | 의미 |
| --- | --- |
| `disabled` | 웹 검색 비활성화 |
| `explicit_only` | 사용자가 검색을 명시한 경우만 검색 |
| `automatic` | 최신성/외부 사실 확인이 중요할 때 검색 |
| `search_first_factual` | 기본값. 사실 확인성 질문은 가능한 먼저 검색 |

## 11. 수동 서비스 생성이 필요한 경우

Blueprint가 아니라 직접 만들고 싶다면 다음처럼 설정합니다. 보통은 Blueprint 방식을 권장합니다.

1. Render Dashboard에서 **New +** 클릭
2. **Background Worker** 선택
3. GitHub repo 선택
4. Language 또는 Runtime: **Docker**
5. Branch: `main`
6. Plan: `Starter`
7. Dockerfile Path: `./Dockerfile`
8. Docker Context: `.`
9. Start Command는 비워둠
   - Dockerfile의 `CMD`를 사용합니다.
10. Environment에 최소 secret 입력
   - `DISCORD_TOKEN`
   - `GROQ_API_KEY`

수동 생성 시에도 다음 값은 꼭 유지해야 합니다.

```text
WEB_SEARCH_BASE_URL=http://127.0.0.1:8888
WEB_SEARCH_PROVIDER=searxng
WEB_SEARCH_ENABLED=true
DATABASE_PATH=/var/data/chococobot.sqlite3
PYTHON_BIN=/app/.venv/bin/python
```

## 12. 로컬 Docker smoke 테스트

로컬에 Docker daemon이 켜져 있다면 다음 명령으로 이미지 빌드와 smoke mode를 확인할 수 있습니다.

```bash
scripts/docker-smoke.sh
```

이 스크립트는 다음을 수행합니다.

1. Docker image build
2. `.env.smoke`를 사용해 컨테이너 실행
3. `SMOKE_MODE=1`로 Discord 로그인 없이 설정과 SearXNG JSON endpoint 확인

`SMOKE_MODE=1`에서는 `client.login()`을 호출하지 않습니다.

## 13. 문제 해결

### 배포 중 `DISCORD_TOKEN` missing

Render Environment에 `DISCORD_TOKEN`이 없거나 비어 있는 상태입니다. Environment 메뉴에서 값을 넣고 redeploy하세요.

### 봇은 켜졌는데 웹 검색이 unavailable

확인할 것:

1. Render logs에 SearXNG readiness 경고가 있는지 확인
2. `WEB_SEARCH_BASE_URL=http://127.0.0.1:8888`인지 확인
3. `WEB_SEARCH_ENABLED=true`인지 확인
4. 시간이 지나 다시 검색 요청을 해보기

SearXNG가 일시적으로 느리면 봇은 살아 있고 검색만 실패할 수 있습니다.

### Render build가 너무 오래 걸림

첫 Docker build는 SearXNG와 Python/TTS dependency를 설치하므로 시간이 걸릴 수 있습니다. 이후 deploy는 cache 상황에 따라 빨라질 수 있습니다.

### SearXNG를 외부 URL로 접속할 수 없음

정상입니다. 현재 설계는 SearXNG를 공개하지 않습니다. `127.0.0.1:8888`은 컨테이너 내부에서만 접근됩니다.

## 14. 현재 배포 구조 요약

```text
Render Starter Background Worker 1개
└── Docker container
    ├── local SearXNG: 127.0.0.1:8888
    └── ChococoBot: Discord gateway connection
```

외부 공개 HTTP service는 없습니다. SearXNG도 공개하지 않습니다.
