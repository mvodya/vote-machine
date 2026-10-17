FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
RUN npm install --global pnpm@11.25.0 --registry=https://registry.npmjs.org
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY db/package.json db/package.json
RUN --mount=type=cache,id=vote-machine-pnpm,target=/pnpm/store \
    pnpm install --filter @vote-machine/db --prod --frozen-lockfile --store-dir=/pnpm/store
COPY db/ db/
WORKDIR /app/db
USER node
CMD ["node", "migrate.mjs"]
