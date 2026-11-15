# syntax=docker/dockerfile:1

# ---------- build stage ----------
# Full Debian image: includes python3, make and g++ needed by node-gyp.
FROM node:22-bookworm AS build
WORKDIR /app

# node:22 ships npm 10, which ignores package.json "allowScripts" and runs every
# dependency's install script. Use the same npm as development so only the
# packages approved in allowScripts run their install scripts (none currently).
RUN npm install -g npm@11.19.0

COPY package.json package-lock.json ./
# better-sqlite3 13.x ships prebuilt binaries inside the npm package (linux glibc
# x64/arm64 included) and loads them when nothing was compiled.
RUN npm ci

# Fail the build here if the native binary is missing or broken.
RUN node -e "const D=require('better-sqlite3'); console.log('better-sqlite3 OK, SQLite', new D(':memory:').prepare('select sqlite_version() v').get().v)"

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage ----------
# Same Debian release (bookworm) as the build stage, so the native binary's glibc matches.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown node:node /app/data
USER node

# SQLite database lives here; mount a volume so it survives container restarts.
VOLUME ["/app/data"]

# Secrets come from the environment (docker run --env-file / compose env_file);
# config.json is mounted at /app/config.json.
CMD ["node", "dist/index.js"]
