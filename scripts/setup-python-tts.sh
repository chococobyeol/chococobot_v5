#!/usr/bin/env bash
set -euo pipefail

VENV_DIR="${PYTHON_TTS_VENV:-.venv}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install edge-tts gTTS
