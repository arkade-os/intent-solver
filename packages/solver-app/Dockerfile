# Single-image deployment: the whole provider in one long-lived process.
#
# The container is OUTBOUND-ONLY: the default command is `relay`, which opens
# no listening port at all. Swap requests arrive over a WebSocket the container
# itself dials, so the solver is reachable without being addressable — the
# end-state architecture, and the only mode the wallet actually speaks.
#
# It defaults that way because the alternative default was a live footgun. A
# platform that builds this Dockerfile and runs it (Dokploy, Railway, Fly, a
# bare `docker run`) takes CMD as-is, so an image defaulting to `serve` came up
# as an HTTP host bound to 127.0.0.1, never dialled the relay, and published
# nothing — while looking perfectly healthy in the logs. Every client then
# waited out its full timeout and blamed the solver. The default has to be the
# mode that actually serves traffic.
#
# Two stages so the runtime image carries no compilers: better-sqlite3 needs a
# native build when no prebuild matches, and that toolchain must not ship.
#
# THE BUILD CONTEXT IS THE REPO ROOT, not this directory. Every path below is
# root-relative and the build is:
#
#   docker build -f packages/solver-app/Dockerfile .
#
# It has to be, and the file lives here anyway. A pnpm workspace image needs
# `pnpm-lock.yaml`, `pnpm-workspace.yaml` and every `packages/*` — this app
# resolves eleven of them through `workspace:*` links the lockfile records — so
# a context rooted at this directory could not install at all. Keeping the file
# beside the thing it builds is what makes the deployable self-describing; a
# platform that is pointed at it must be told the context, and `-f` is the whole
# of that instruction.

# Which Node the image is built on. Defaults to 22 — active LTS until April
# 2027, and the conservative choice for something that moves money — while
# `engines.node` (`>=22.6.0 <27`) permits 24 as well. CI builds this file at
# BOTH ends of that range, so the range is a tested claim rather than a
# declaration.
#
# Declared before the first FROM so both stages can read it; ARGs above the
# first FROM are global, and one declared inside a stage would not be visible
# to the other stage's FROM.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS build
RUN corepack enable
WORKDIR /app
# Build deps for better-sqlite3's node-gyp fallback.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The workspace packages must land BEFORE `pnpm install`: the lockfile records
# `@arkade-os/solver-*` as workspace links, and a frozen install fails outright if the
# projects they point at are absent.
#
# This copies package SOURCES into the install layer, so editing one busts the
# dependency cache. Docker's COPY flattens wildcards, so `packages/*/package.json`
# cannot preserve the directory each manifest belongs to — separating manifests
# from sources would mean one COPY per package, re-listed by hand on every split.
# Correctness first; the cost is a slower rebuild, not a wrong image.
#
# This app's own source arrives in the same COPY: it is `packages/solver-app`,
# one workspace project among twelve, and there is deliberately no second copy
# of it.
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# The root tsconfig, which every package's `tsconfig.build.json` extends — not
# an emit config in its own right. The root emits nothing at all now.
COPY tsconfig.json ./
COPY scripts ./scripts
# `pnpm build` is `pnpm -r build`, and pnpm orders that topologically: each
# package resolves its dependencies through their `exports` maps to dist/, so
# the app compiles last, after everything it imports exists.
RUN pnpm build
# Drop dev dependencies; keep the compiled native module.
#
# CI=true is REQUIRED since the workspace split, not decoration. Pruning a
# workspace makes pnpm remove and rebuild node_modules wholesale rather than
# unlinking a few packages, and it refuses to delete a modules directory
# without a TTY unless told it is running unattended:
#
#   ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
#
# A local `docker build` can hide this by reusing a cached layer from before
# the workspace existed, so it first appeared on the CI run.
RUN CI=true pnpm prune --prod

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# The workspace packages, and they are NOT optional. pnpm links `@arkade-os/solver-*` into
# node_modules as SYMLINKS to /app/packages/<pkg>; copying node_modules without
# them leaves every one dangling, and the image fails at require time with
# ERR_MODULE_NOT_FOUND on a path that plainly exists in the build stage.
#
# Their dist/ is what actually runs — the .ts sources ride along because
# splitting them out would need one COPY per package, re-listed on every split,
# to save a few hundred kilobytes.
#
# This is now the ONLY copy that matters: the app itself is
# `packages/solver-app`, so the line below carries the entrypoint too. There is
# no root `dist/` any more.
COPY --from=build /app/packages ./packages
# The admin console's client, copied as-is: `pnpm build` is plain `tsc`, which
# does not carry non-TS files, and the console resolves this directory from
# import.meta.url. It has to sit beside the compiled module that reads it.
#
# Redundant on paper — the `packages` copy above already carries the app's
# `src/`, which is `staticRoot()`'s second candidate — and kept anyway, because
# the first candidate is the one that should hit. A future `.dockerignore` rule
# or a slimmed COPY that drops package sources would otherwise turn the console
# into a 404 with nothing red anywhere.
COPY --from=build /app/packages/solver-app/src/admin/static ./packages/solver-app/dist/admin/static
# The operator diagnostics, which are only ever needed ON the box that has the
# problem. They are plain .mjs run by the same node and against the same
# node_modules, so they ship as source rather than through `tsc`.
#
# Reaching for one of these means an incident is already underway, and an image
# that lacks them forces `docker cp` into a container that may not permit it —
# which is exactly where swap d69041e8 was diagnosed by pasting scripts down a
# pipe. They cost a few kilobytes; not having them cost hours.
COPY --from=build /app/scripts ./scripts

# Durable state lives on a volume: the swap DB is the money-critical file.
# DB_DIR places every database file this service opens itself; the heartbeat is
# not one — the HEALTHCHECK below reads that exact path — so it is named
# separately.
RUN mkdir -p /data && chown node:node /data /app
ENV DB_DIR=/data \
    RELAY_HEALTH_PATH=/data/relay-health
VOLUME /data

USER node

# Health, for a container with no port to probe: `relay` touches the mtime of
# RELAY_HEALTH_PATH every 10s, but ONLY while the relay socket is up. Reconnect
# is automatic and unbounded, so a process check reports a disconnected solver
# healthy for as long as it stays deaf — which is how one shipped.
#
# It covers socket connectivity, not reachability: a relay that tears down our
# subscription leaves the socket up. See this package's src/cli.ts heartbeat.
#
# 60s of staleness is six missed beats, but that is the PROBE's threshold, not
# when the container turns unhealthy — Docker needs `--retries` consecutive
# failures first. At interval=30s and retries=2 a solver that goes deaf at t=0
# is marked unhealthy between t=90s and t=120s (the file passes 60s stale, then
# two probes must land). --retries is explicit because the default is 3, which
# would stretch that to 120-150s while this comment said 60. Two rather than
# one so a single filesystem hiccup cannot restart a money-mover.
#
# A shell probe, not `node -e`: measured 5ms and ~2MB RSS against 42ms and
# ~44MB for spawning Node. CPU either way is affordable at one probe per
# interval; the 44MB transient is not, on the small PaaS instances this default
# targets, where it counts against the same memory limit as the solver. `stat`
# and `date` are Essential in the debian base. `test` rather than `[` so Docker
# cannot mistake the line for JSON exec form.
#
# Overriding CMD to `serve` means overriding this too — that mode has an HTTP
# probe instead. The `swap-provider-http` service in docker-compose.yml carries
# the override verbatim; keeping one copy means one thing to change.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=2 \
  CMD test $(( $(date +%s) - $(stat -c %Y "${RELAY_HEALTH_PATH:-/data/relay-health}" 2>/dev/null || echo 0) )) -lt 60

# The admin console, when ADMIN_PORT is set. Not published by default and not
# EXPOSEd with a fixed number, because there is deliberately no default port:
# the console is opt-in, and a declared port on an image whose console is off
# would advertise something that is not listening.
#
# THERE IS NO AUTHENTICATION ON THAT PORT. Anything that can reach it can move
# money. In a container ADMIN_HOST must be 0.0.0.0 to be reachable at all, so
# publish it only behind a reverse proxy that adds auth — never with a bare
# `-p 8788:8788` on a public host. See docs/runbook.md.

# Secrets come from the environment (docker secrets / --env-file), never from
# the image. `relay` additionally needs RELAY_URL.
ENTRYPOINT ["node", "--enable-source-maps", "--experimental-eventsource", "packages/solver-app/dist/cli.js"]
CMD ["relay"]
