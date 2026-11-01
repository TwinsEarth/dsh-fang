# SPDX-License-Identifier: AGPL-3.0-or-later
# Minimal release health image: serves /healthz for the published package.
FROM node:24-alpine

LABEL org.opencontainers.image.title="dsh-fang-healthz" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/TwinsEarth/dsh-fang"

WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json /app/package.json
COPY LICENSE-CORE LICENSE-SDK NOTICE /app/
COPY docker/healthz-server.mjs /app/docker/healthz-server.mjs

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

USER node
CMD ["node", "docker/healthz-server.mjs"]
