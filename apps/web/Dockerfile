FROM node:24.15.0-bookworm-slim AS deps
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0 --registry=https://registry.npmjs.org
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# For building WEB app
FROM deps AS build
COPY apps/web/ apps/web/
RUN pnpm --filter @vote-machine/web build

# WEB runtime
FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
