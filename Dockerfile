# syntax=docker/dockerfile:1

# Behest's production image: the Next.js standalone server, which also runs the job worker when
# WORKER=1, and the database migrations compiled to one plain Node script. Each start applies any
# pending migrations, then starts the server. docker-compose.yml runs it next to Postgres and Caddy;
# docs/deploy.md walks through a deployment.

ARG NODE_VERSION=22

# Dependencies, installed exactly as the lockfile pins them. The build needs the dev dependencies
# too (TypeScript, Tailwind and the bundler for the migrations), and none of them reach the final image.
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# The build: the standalone server in .next/standalone, then scripts/migrate.ts bundled with the
# schema, Drizzle and the Postgres driver into one file. PGlite stays outside the bundle: the
# standalone server already carries it, and it only matters when DATABASE_URL is unset, which the
# image refuses.
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN node_modules/.bin/esbuild scripts/migrate.ts --bundle --platform=node --target=node22 --format=cjs \
      --external:@electric-sql/pglite --external:pg-native --log-level=warning --outfile=dist/migrate.cjs

# The image that runs: the standalone server with its static files, and the migrations with their SQL.
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/drizzle ./drizzle
COPY --from=builder --chown=node:node /app/dist/migrate.cjs ./scripts/migrate.cjs
# The node user that ships with the base image, so the server never runs as root.
USER node
EXPOSE 3000
# exec hands the shell's process over to the server, so stop signals reach it directly.
CMD ["sh", "-c", "node scripts/migrate.cjs && exec node server.js"]
