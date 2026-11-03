FROM node:24.19.0-bookworm-slim AS source
WORKDIR /app
ARG SIGONGNOTE_SOURCE_SHA
ARG SIGONGNOTE_ARCHIVE_SHA256
# Build context comes from release-control prepare, never the working tree.
COPY source.tar /tmp/sigongnote-source.tar
RUN node -e 'const fs=require("fs"),c=require("crypto"),b=fs.readFileSync("/tmp/sigongnote-source.tar");if(!/^[a-f0-9]{40}$/.test(process.env.SIGONGNOTE_SOURCE_SHA)||c.createHash("sha256").update(b).digest("hex")!==process.env.SIGONGNOTE_ARCHIVE_SHA256||!b.subarray(512,1024).toString().includes(" comment="+process.env.SIGONGNOTE_SOURCE_SHA+"\n"))process.exit(1)' && \
    tar -xf /tmp/sigongnote-source.tar -C /app

FROM source AS build
RUN npm ci --ignore-scripts
RUN npm run build --workspace @sigongnote/contracts && \
    npm run build --workspace @sigongnote/domain && \
    npm run build --workspace @sigongnote/api && \
    npm run build --workspace @sigongnote/web && \
    node scripts/write-release.mjs "$SIGONGNOTE_SOURCE_SHA" "$SIGONGNOTE_ARCHIVE_SHA256" && \
    npm prune --omit=dev --ignore-scripts

FROM python:3.13.12-slim-bookworm AS python
WORKDIR /app/services/document-worker
RUN pip install --no-cache-dir uv==0.11.19
COPY --from=source /app/services/document-worker/pyproject.toml /app/services/document-worker/uv.lock ./
COPY --from=source /app/services/document-worker/src ./src
RUN UV_PYTHON_DOWNLOADS=never uv sync --frozen --no-dev

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV DOCUMENT_PYTHON=/app/services/document-worker/.venv/bin/python \
    SIGONGNOTE_PDF_FONT_PATH=/usr/share/fonts/truetype/nanum/NanumGothic.ttf \
    SIGONGNOTE_TESSERACT=/usr/bin/tesseract \
    SIGONGNOTE_TESSDATA_DIR=/usr/share/tesseract-ocr/5/tessdata \
    SHORT_STT_FFPROBE=/usr/bin/ffprobe \
    WORKER_HEARTBEAT_FILE=/tmp/sigongnote-worker-health.json
WORKDIR /app
# CPython copied from the Python stage still needs its Debian shared libraries.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-nanum tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng ffmpeg libssl3 libsqlite3-0 libgdbm6 libncursesw6 libreadline8 libexpat1 libffi8 libbz2-1.0 liblzma5 && rm -rf /var/lib/apt/lists/*
RUN test -x "$SHORT_STT_FFPROBE" && test -x /usr/bin/ffmpeg
RUN test -x "$SIGONGNOTE_TESSERACT" && \
    test -r "$SIGONGNOTE_TESSDATA_DIR/kor.traineddata" && \
    test -r "$SIGONGNOTE_TESSDATA_DIR/eng.traineddata" && \
    "$SIGONGNOTE_TESSERACT" --tessdata-dir "$SIGONGNOTE_TESSDATA_DIR" --list-langs 2>/dev/null | grep -qx 'kor' && \
    "$SIGONGNOTE_TESSERACT" --tessdata-dir "$SIGONGNOTE_TESSDATA_DIR" --list-langs 2>/dev/null | grep -qx 'eng'
COPY --from=python /usr/local /usr/local
COPY --from=python /app/services/document-worker /app/services/document-worker
RUN /app/services/document-worker/.venv/bin/python -c "import ssl, sqlite3, ctypes, xml.parsers.expat, bz2, lzma, dbm.gnu, readline; import PIL, reportlab, openpyxl, pypdf, pdfplumber, av, xlrd, olefile, defusedxml, jsonschema"
COPY --from=source /app/trade-packs ./trade-packs
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/services/api/package.json ./services/api/package.json
COPY --from=build /app/services/api/dist ./services/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=source /app/scripts/run-cloud-service.mjs /app/scripts/cloud-child-env.mjs /app/scripts/cloud-supervisor.mjs /app/scripts/check-short-stt-runtime.mjs ./scripts/
USER node
RUN node scripts/check-short-stt-runtime.mjs
EXPOSE 10000
CMD ["node", "scripts/run-cloud-service.mjs"]
