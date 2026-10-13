# Local Linux check environment: same toolchain versions as the CI matrix.
FROM node:24.21.0-trixie-slim AS node
FROM rust:1.99.0-trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
    cmake clang git ca-certificates curl file xdg-utils \
    webkit2gtk-driver xvfb xauth dbus-x11 at-spi2-core gnome-keyring strace \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install tauri-driver --version 2.1.0 --locked
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && npm install -g pnpm@12.11.2
ENV pnpm_config_store_dir=/pnpm-store
WORKDIR /work
