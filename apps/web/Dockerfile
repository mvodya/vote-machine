FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS media_tools
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libjxl-tools && rm -rf /var/lib/apt/lists/*

FROM media_tools AS deps
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0 --registry=https://registry.npmjs.org
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY db/package.json db/package.json
RUN --mount=type=cache,id=vote-machine-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# For building WEB app
FROM deps AS build
COPY apps/web/ apps/web/
RUN pnpm --filter @vote-machine/web build
# Standalone tracing keeps packages but omits direct links used by the worker
RUN mkdir -p apps/web/.next/standalone/apps/web/node_modules/@aws-sdk \
    && cp -P apps/web/node_modules/sharp apps/web/.next/standalone/apps/web/node_modules/ \
    && cp -P apps/web/node_modules/@aws-sdk/client-s3 apps/web/.next/standalone/apps/web/node_modules/@aws-sdk/ \
    && node -e "const r=require('node:module').createRequire('/app/apps/web/.next/standalone/apps/web/server.js'); r('sharp'); r('@aws-sdk/client-s3');"

# WEB runtime
FROM media_tools AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/scripts ./apps/web/scripts
COPY --from=build --chown=node:node /app/apps/web/lib/server ./apps/web/lib/server
USER node
EXPOSE 3000
CMD ["node", "apps/web/scripts/web-server.mjs"]
