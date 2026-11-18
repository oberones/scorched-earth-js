# Base digests match the ones verified for the sibling hyperprism-js project.
# The page bundle is plain JS, so build it natively even when targeting another CPU.
FROM --platform=$BUILDPLATFORM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
# No npm dependencies: the bundler and server use only Node built-ins.
COPY package.json ./
COPY tools/build.js ./tools/build.js
COPY src/ ./src/
RUN node tools/build.js

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE
LABEL org.opencontainers.image.title="Scorched Earth" \
      org.opencontainers.image.description="Browser artillery game with an authoritative multiplayer server" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE}"
WORKDIR /srv/scorched
# The server runs the same engine files as the browser; nothing else from src/ is needed.
COPY src/config.js src/terrain.js src/physics.js src/ai.js src/game.js ./src/
COPY server/server.js ./server/server.js
COPY server/lib/ ./server/lib/
COPY --from=build /app/dist/ ./dist/
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/srv/scorched/dist \
    APP_VERSION=${VERSION}
# Application files stay root-owned and read-only to the runtime user (node, 1000).
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
# Node is PID 1 and handles SIGTERM itself (drains rooms, closes sockets with 1001).
ENTRYPOINT ["node"]
CMD ["server/server.js"]
