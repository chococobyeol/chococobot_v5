# Agent Runtime Reliability Plan

## 목적

`!? 배달 채널 내용 요약해봐` 같은 읽기 전용 채널 기록 요청이 AgentRuntime 단계에서 실패하더라도 일반 AI 채팅으로 빠져 "채널 내용을 알려 주세요"라고 답하지 않도록 한다.

이 문서는 다음 로그 증상을 해결하기 위한 구현 가이드다.

- 모델이 `{"status":"not_handled"}` 또는 `{"action":"not_handled"}`처럼 `kind` 없는 JSON을 반환해 `Unknown kind: (missing)` parse error가 발생한다.
- API가 `400 Tool choice is none, but model called a tool`을 반환한다.
- AgentRuntime 실패 뒤 channel-history 경로가 아니라 일반 chat fallback으로 이동해 실제 채널 기록을 읽지 못한다.

## 현재 근거

- `src/services/agentRuntime.ts`
  - `buildMessages`는 system prompt를 `MAX_SYSTEM_CHARS=5200`으로 자르고, 출력 예시 `outputs=...`를 맨 뒤에 둔다.
  - `parseAgentEnvelope`는 top-level `kind`만 허용한다.
  - AgentRuntime은 provider native tool call이 아니라 텍스트 JSON `{"kind":"tool_calls", ...}` 계약을 기대한다.
- `src/services/aiService.ts`
  - Groq chat completion 요청에는 `tools` 또는 `tool_choice`가 없다.
- `src/bot.ts`
  - AgentRuntime이 `not_handled` 또는 error를 내면 일반 `aiChat.handlePrompt`로 fallback한다.
  - 이 fallback은 Discord channel history tool을 실행하지 않는다.
- `src/services/toolRegistry.ts`
  - `history.search`는 read-only auto tool이며, `mode='summary'`에서는 빈 `query`를 허용한다.

## 목표 동작

1. 일반 대화는 기존처럼 chat fallback이 가능해야 한다.
2. 채널/서버 기록 요약·검색 요청은 AgentRuntime이 실패해도 channel-history/history path로 복구되어야 한다.
3. 모델이 top-level `status` 또는 `action`을 실수로 써도 안전한 범위에서는 복구해야 한다.
4. 실행/삭제/설정/음성 요청은 AgentRuntime 실패 후 다른 경로에서 자동 실행되면 안 된다.
5. system prompt에서 핵심 출력 계약은 채널 수나 도구 설명 길이에 의해 잘리면 안 된다.

## 비목표

- 이번 작업에서 provider-native tool calling으로 전면 마이그레이션하지 않는다.
- 삭제/설정/음성 명령의 자동 실행 범위를 넓히지 않는다.
- 채널 기록 저장소나 permission 정책을 변경하지 않는다.

## 구현 계획

### 1. AgentRuntime 출력 계약을 앞쪽 고정 영역으로 분리

대상 파일: `src/services/agentRuntime.ts`

현재 `buildMessages`는 출력 예시를 prompt 끝에 둔다. 동적 컨텍스트가 길면 출력 계약이 잘릴 수 있으므로 다음처럼 구조를 바꾼다.

- `contract` 영역을 먼저 구성한다.
- `contract`에는 반드시 다음을 포함한다.
  - top-level field는 `kind`여야 한다.
  - 허용 kind 목록.
  - native/provider tool call 금지.
  - 도구 호출도 JSON 텍스트 `{"kind":"tool_calls",...}`로만 출력.
  - `{"kind":"not_handled"}` 예시.
  - `{"kind":"tool_calls","calls":[...]}` 예시.
- `ctx`, `web`, `tools`, 채널 목록 등 동적 정보만 별도로 truncate한다.
- 최종 system prompt는 `contract + dynamicContext` 형태로 만든다.

수용 기준:

- 참조 가능한 텍스트 채널이 40개여도 system prompt 안에 `top-level field`, `kind`, `not_handled`, `tool_calls` 예시가 남아 있어야 한다.
- `history.search` 도구 설명이 잘려도 출력 계약은 잘리지 않아야 한다.

### 2. `status`/`action` 오출력의 제한적 복구 추가

대상 파일: `src/services/agentRuntime.ts`

`parseAgentEnvelope`에서 `kind`가 없을 때 다음을 제한적으로 허용한다.

- `parsed.status` 또는 `parsed.action`이 안전한 non-tool envelope이면 `kind`처럼 해석한다.
- 허용 후보:
  - `not_handled`
  - `confirm_pending`
  - `final` 단, `message`가 유효할 때만
  - `clarify` 단, `message`가 유효할 때만
  - `unavailable` 단, `message`가 유효할 때만
  - `blocked` 단, `message`가 유효할 때만
- `tool_calls`는 복구하지 않는다. 실행성 도구 호출은 반드시 명시적 `kind:'tool_calls'`여야 한다.

수용 기준:

- `{"status":"not_handled"}`는 `{ kind: 'not_handled' }`로 처리된다.
- `{"action":"not_handled"}`는 `{ kind: 'not_handled' }`로 처리된다.
- `{"status":"tool_calls",...}`는 parse error로 남는다.

### 3. AgentRuntime 실패 시 읽기 전용 history fallback 추가

대상 파일: `src/bot.ts`

현재 `handleAiPrompt`는 AgentRuntime error 또는 `not_handled` 이후 일반 chat으로 바로 이동한다. 이를 다음 흐름으로 바꾼다.

```text
AgentRuntime outcome/error
  -> pending channel-history reply면 기존 pending 처리
  -> prompt가 채널/서버 기록 요약·검색 요청이면 channel-history/planner 경로로 fallback
  -> 그 외 일반 대화면 aiChat fallback
  -> 실행/삭제/설정/음성 요청은 fallback에서 자동 실행 금지
```

구현 방식 후보:

- 기존 `handleAiCommandPlannerPrompt`를 재사용하되, fallback 호출에서는 command 실행을 막는 read-only mode를 추가한다.
- 또는 `routeNaturalLanguageCommand`/간단한 history intent detector를 통해 history 요청만 `handleChannelHistoryPlan`/`handleGuildChannelHistoryPlan`으로 보낸다.

권장:

- 안전성 때문에 fallback에서는 `channel-history`, `time`, `chat`, `clarify`, `unavailable` 정도만 허용한다.
- `command` 또는 `confirm_pending`이 나오면 실행하지 말고 일반 chat 또는 blocked 안내로 처리한다.

수용 기준:

- `!? 배달 채널 내용 요약해봐`에서 AgentRuntime이 400을 던져도 일반 chat 대신 channel-history path가 호출된다.
- `!? 들어와`, `!? 청소 3`, `!? 프리픽스 바꿔줘` 같은 실행성 요청은 AgentRuntime 실패 후 fallback으로 실행되지 않는다.

### 4. provider-native tool call 누출 에러를 명시적으로 분류

대상 파일: `src/services/aiService.ts` 또는 `src/bot.ts`

`Tool choice is none, but model called a tool` 에러는 단순 generic 400보다 의미가 분명하다. 진단과 fallback 조건에서 활용할 수 있게 분류한다.

권장 구현:

- `extractErrorDetails` 결과의 `errorMessage`에 해당 문구가 있으면 helper로 감지한다.
- AgentRuntime catch에서 이 에러를 `agent_native_tool_call_leak` 같은 decisionKind로 로깅한다.
- history 요청이면 3번 fallback으로 복구한다.

수용 기준:

- 로그에서 해당 400이 일반 `error`뿐 아니라 원인 분류 가능한 decisionKind 또는 validation context로 남는다.

### 5. 테스트 추가

대상 파일 후보:

- `tests/agentRuntime.test.ts`
- `tests/botRouting.test.ts`
- 필요 시 `tests/agentPromptContract.test.ts`

필수 테스트:

1. prompt 계약 보존
   - 채널 40개 환경에서도 system prompt에 `kind`, `tool_calls`, `not_handled`, native tool call 금지 문구가 포함된다.
2. parser 복구
   - `{"status":"not_handled"}` 복구.
   - `{"action":"not_handled"}` 복구.
   - `{"status":"tool_calls"}` 미복구.
3. history fallback
   - AgentRuntime이 `Tool choice is none...` 400을 던질 때, history 요약 요청은 channel-history path로 간다.
4. 실행성 fallback 금지
   - AgentRuntime이 실패해도 `들어와`, `청소`, `프리픽스 변경` 등이 fallback으로 실행되지 않는다.
5. 기존 동작 보존
   - 일반 `!? 안녕`은 여전히 chat fallback이 가능하다.

## 권장 작업 순서

1. 테스트로 현재 실패 형태를 먼저 고정한다.
2. AgentRuntime prompt 계약을 분리하고 prompt contract 테스트를 통과시킨다.
3. `status`/`action` 제한 복구를 구현하고 parser 테스트를 통과시킨다.
4. `bot.ts`에 read-only history fallback을 추가하고 routing 테스트를 통과시킨다.
5. provider-native tool call leak 진단 분류를 추가한다.
6. 전체 검증을 실행한다.

## 검증 명령

```bash
npm run typecheck
npm test -- tests/agentRuntime.test.ts tests/botRouting.test.ts tests/agentPromptContract.test.ts
npm test
```

## 리스크와 완화

| 리스크 | 완화 |
|---|---|
| fallback planner가 실행성 command를 반환해 의도치 않은 실행이 될 수 있음 | fallback에서는 read-only 결과만 허용하거나 command를 차단한다 |
| `status/action` 복구가 실행성 tool call까지 허용할 수 있음 | `tool_calls`는 복구 대상에서 제외한다 |
| prompt 길이 조정으로 도구 설명이 부족해질 수 있음 | 출력 계약을 우선하고, 도구 설명은 compact하게 유지한다 |
| 일반 chat fallback이 줄어 사용자 경험이 변할 수 있음 | history intent일 때만 channel-history fallback을 적용한다 |

## 완료 기준

- 위 필수 테스트가 모두 통과한다.
- `npm run typecheck`가 통과한다.
- AgentRuntime 로그에서 `Unknown kind: (missing)` 반복이 줄어든다.
- history 요약 요청은 AgentRuntime 실패 시에도 실제 history path로 복구된다.
- 실행성 요청은 fallback으로 자동 실행되지 않는다.

## 구현 메모

2026-05-24 구현에서는 문서의 권장 방향을 다음처럼 구체화했다.

- `src/services/agentRuntime.ts`에 고정 `AGENT_OUTPUT_CONTRACT`를 두고, `ctx`/`web`/`tools` 같은 동적 컨텍스트만 남은 길이 안에서 truncate한다.
- 동적 컨텍스트에서는 `tools`를 `ctx`보다 앞에 둬서 채널 목록이 길어도 `history.search` 같은 핵심 도구 이름이 유지되도록 했다.
- `status`/`action` alias 복구는 `not_handled`, `confirm_pending`, `final`, `clarify`, `unavailable`, `blocked`만 허용한다. `tool_calls`는 복구하지 않는다.
- `src/bot.ts`의 AgentRuntime fallback은 먼저 읽기 전용 history 요청인지 휴리스틱으로 확인한 뒤 planner를 호출한다. planner 결과 중 `channel-history`, `time`, `clarify`, `unavailable`만 처리하고, `command`/`confirm_pending`은 실행하지 않는다.
- `Tool choice is none, but model called a tool` 분류 helper는 `src/bot.ts`에 두고 AgentRuntime error diagnostic의 `decisionKind=agent_native_tool_call_leak`로 남긴다.
