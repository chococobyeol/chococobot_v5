#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/app}"
SEARXNG_SRC="${SEARXNG_SRC:-/usr/local/searxng/searxng-src}"
SEARXNG_VENV="${SEARXNG_VENV:-/usr/local/searxng/searx-pyenv}"
SEARXNG_PORT="${SEARXNG_PORT:-8888}"
SEARXNG_HOST="${SEARXNG_HOST:-127.0.0.1}"
SEARXNG_READY_TIMEOUT_SECONDS="${SEARXNG_READY_TIMEOUT_SECONDS:-25}"

export SEARXNG_SETTINGS_PATH="${SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}"
export WEB_SEARCH_PROVIDER="${WEB_SEARCH_PROVIDER:-searxng}"
export WEB_SEARCH_ENABLED="${WEB_SEARCH_ENABLED:-true}"
export WEB_SEARCH_BASE_URL="${WEB_SEARCH_BASE_URL:-http://${SEARXNG_HOST}:${SEARXNG_PORT}}"
export PYTHON_BIN="${PYTHON_BIN:-${APP_DIR}/.venv/bin/python}"

if [[ -z "${SEARXNG_SECRET:-}" ]]; then
  SEARXNG_SECRET="$(${PYTHON_BIN} - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
  export SEARXNG_SECRET
fi

searxng_pid=""
bot_pid=""

terminate() {
  local code=$?
  trap - TERM INT EXIT
  if [[ -n "${bot_pid}" ]] && kill -0 "${bot_pid}" 2>/dev/null; then
    kill "${bot_pid}" 2>/dev/null || true
  fi
  if [[ -n "${searxng_pid}" ]] && kill -0 "${searxng_pid}" 2>/dev/null; then
    kill "${searxng_pid}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  exit "${code}"
}
trap terminate TERM INT EXIT

start_searxng() {
  echo "Starting local SearXNG on ${WEB_SEARCH_BASE_URL}"
  cd "${SEARXNG_SRC}"
  "${SEARXNG_VENV}/bin/python" -m searx.webapp &
  searxng_pid=$!
}

wait_for_searxng() {
  local deadline=$((SECONDS + SEARXNG_READY_TIMEOUT_SECONDS))
  local root_url="${WEB_SEARCH_BASE_URL%/}/"
  until curl --silent --show-error --fail --max-time 3 --head "${root_url}" >/dev/null 2>&1; do
    if [[ -n "${searxng_pid}" ]] && ! kill -0 "${searxng_pid}" 2>/dev/null; then
      echo "SearXNG process exited before readiness; continuing so the bot can stay online without web search." >&2
      return 1
    fi
    if (( SECONDS >= deadline )); then
      echo "SearXNG did not become ready within ${SEARXNG_READY_TIMEOUT_SECONDS}s; continuing so the bot can stay online without web search." >&2
      return 1
    fi
    sleep 1
  done
  echo "SearXNG readiness probe passed."
}

start_bot() {
  cd "${APP_DIR}"
  node dist/src/index.js &
  bot_pid=$!
  wait "${bot_pid}"
}

start_searxng
wait_for_searxng || true
start_bot
