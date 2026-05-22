#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKIP_PYTHON_TTS_SETUP:-}" == "1" ]]; then
  echo "Skipping Python TTS setup because SKIP_PYTHON_TTS_SETUP=1"
  exit 0
fi

VENV_DIR="${PYTHON_TTS_VENV:-.venv}"
PYTHON_SETUP_BIN="${PYTHON_SETUP_BIN:-python3}"

"$PYTHON_SETUP_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install edge-tts gTTS
