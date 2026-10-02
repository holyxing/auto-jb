FROM node:22-alpine AS web
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY web web
COPY extension extension
COPY scripts/build-extension.mjs scripts/build-extension.mjs
RUN npm run build
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev
COPY backend backend
COPY fixtures fixtures
COPY --from=web /build/dist/web dist/web
COPY --from=web /build/dist/extension dist/extension
ENV PYTHONPATH=/app/backend
CMD ["/app/.venv/bin/uvicorn", "auto_jb.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
