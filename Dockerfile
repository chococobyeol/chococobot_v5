FROM node:22-bookworm-slim AS app-build
WORKDIR /app
ENV SKIP_PYTHON_TTS_SETUP=1
COPY package*.json ./
COPY scripts/setup-python-tts.sh ./scripts/setup-python-tts.sh
RUN npm ci
COPY tsconfig.json eslint.config.js vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    APP_DIR=/app \
    SEARXNG_SRC=/usr/local/searxng/searxng-src \
    SEARXNG_VENV=/usr/local/searxng/searx-pyenv \
    SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml \
    SEARXNG_PORT=8888 \
    SEARXNG_HOST=127.0.0.1 \
    WEB_SEARCH_PROVIDER=searxng \
    WEB_SEARCH_ENABLED=true \
    WEB_SEARCH_BASE_URL=http://127.0.0.1:8888 \
    PYTHON_BIN=/app/.venv/bin/python
ARG SEARXNG_REPOSITORY=https://github.com/searxng/searxng.git
ARG SEARXNG_REF=master
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    tini \
    build-essential \
    python3-dev \
    python3-venv \
    python-is-python3 \
    libxslt1-dev \
    zlib1g-dev \
    libffi-dev \
    libssl-dev \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/searxng /var/cache/searxng /var/data
COPY config/searxng/settings.yml /etc/searxng/settings.yml
RUN git clone --depth 1 --branch "${SEARXNG_REF}" "${SEARXNG_REPOSITORY}" "${SEARXNG_SRC}" \
  && python -m venv "${SEARXNG_VENV}" \
  && "${SEARXNG_VENV}/bin/python" -m pip install --upgrade pip setuptools wheel \
  && "${SEARXNG_VENV}/bin/python" -m pip install --upgrade pyyaml msgspec typing-extensions pybind11 \
  && cd "${SEARXNG_SRC}" \
  && "${SEARXNG_VENV}/bin/python" -m pip install --use-pep517 --no-build-isolation -e . \
  && python -m venv /app/.venv \
  && /app/.venv/bin/python -m pip install --upgrade pip \
  && /app/.venv/bin/python -m pip install edge-tts gTTS
COPY --from=app-build /app/package*.json ./
COPY --from=app-build /app/node_modules ./node_modules
COPY --from=app-build /app/dist ./dist
COPY scripts/render-start.sh ./scripts/render-start.sh
RUN chmod +x ./scripts/render-start.sh
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "./scripts/render-start.sh"]
