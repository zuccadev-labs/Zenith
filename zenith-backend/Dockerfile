# Zenith backend: one standalone binary (deno compile) on a minimal, non-root runtime.
#
#   docker build -t zenith-backend zenith-backend/
#   docker run -p 1337:1337 -e APP1_MASTER_KEY=… -e MONGO_URI=… zenith-backend
#
# The engine-auth facade loads libzutool through FFI: mount the libraries and point
# `engineAuth.libDir` (or ZUTOOL_LIB_DIR) at them.

# 1. Build — Debian (glibc), the same libc as the runtime image.
FROM denoland/deno:2.9.8 AS builder

WORKDIR /app

# Dependencies first, so source changes reuse this layer. --frozen: exactly what deno.lock says,
# with its integrity hashes; a deno.json that no longer matches the lock fails the build.
COPY deno.json deno.lock ./
RUN deno install --frozen

COPY src/ src/
COPY apps.config.ts config-loader.ts zen.config.ts ./

# mod.ts loads apps.config.ts and config-loader.ts with a computed import(), which `deno compile`
# cannot follow: --include embeds them (without it the binary failed at startup: "Module not found").
# Same permissions as `deno task compile`, plus FFI for the engine-auth binding and
# Deno KV (cloud.ts opens it at startup).
RUN deno compile --unstable-kv --allow-net --allow-read --allow-env --allow-write --allow-sys --allow-ffi \
      --include apps.config.ts --include config-loader.ts \
      --no-check --output zenith-server src/mod.ts --mode=production

# 2. Runtime — Debian slim, not distroless: @node-rs/argon2 picks its glibc build by reading
# /usr/bin/ldd, which distroless lacks, and then fails loading the musl one.
FROM debian:13-slim

# Debian security updates on top of the base image (Trivy fails the CI on fixed CRITICAL/HIGH).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 zenith \
 && useradd --system --uid 10001 --gid 10001 --home-dir /data --create-home zenith
WORKDIR /app
COPY --from=builder /app/zenith-server /app/zenith-server

# Deno KV and runtime data live in /data. With a read-only root filesystem, mount /data
# writable and /tmp writable *with exec*: native addons are extracted there and loaded.
# Uploaded file contents too (ZENITH_FILES_DIR): /app is read-only for the zenith user.
ENV ZENITH_MODE=production DENO_DIR=/data HOME=/data ZENITH_FILES_DIR=/data/files
VOLUME ["/data"]
# 1337: the API. 9090: Prometheus metrics, only when ZENITH_METRICS_PORT=9090 (the Helm chart sets it).
EXPOSE 1337 9090
# Numeric, so Kubernetes can verify runAsNonRoot without reading /etc/passwd.
USER 10001:10001

ENTRYPOINT ["/app/zenith-server"]
