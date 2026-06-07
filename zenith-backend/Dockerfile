# 1. Base image (Deno official)
FROM denoland/deno:alpine-1.42.4 AS builder

WORKDIR /app

# Cache dependencies
COPY deno.json ./
RUN deno cache --no-lock deno.json || true

# Copy source
COPY src/ src/
COPY cloud/ cloud/
COPY zen.config.ts apps.config.ts ./

# Compile into a single static binary
# Targeting linux
RUN deno compile --allow-net --allow-read --allow-env --output zenith-server src/mod.ts

# 2. Final stage (Distroless / Alpine micro)
FROM alpine:3.19

WORKDIR /app

# Add a non-root user
RUN addgroup -S zenith && adduser -S zenith -G zenith
USER zenith

# Copy the standalone binary from the builder
COPY --from=builder /app/zenith-server /app/zenith-server

# Expose standard Zenith port
EXPOSE 23614

# Set required env vars with some defaults
ENV ZENITH_PORT=23614
ENV DENO_ENV=production

# Run the binary
CMD ["/app/zenith-server"]
