FROM debian:12

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config curl ca-certificates file git rsync xz-utils \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libxdo-dev libssl-dev patchelf \
    && rm -rf /var/lib/apt/lists/*

# Node 22 supplies Corepack; it selects package.json's exact packageManager.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/node-setup.sh \
    && bash /tmp/node-setup.sh \
    && rm /tmp/node-setup.sh \
    && apt-get install -y --no-install-recommends nodejs \
    && corepack enable \
    && rm -rf /var/lib/apt/lists/*

COPY src-tauri/rust-toolchain.toml /opt/notemd/rust-toolchain.toml
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain none \
    && channel=$(sed -n 's/^channel = "\(.*\)"/\1/p' /opt/notemd/rust-toolchain.toml) \
    && profile=$(sed -n 's/^profile = "\(.*\)"/\1/p' /opt/notemd/rust-toolchain.toml) \
    && rustup toolchain install "$channel" --profile "$profile" \
    && rustup default "$channel" \
    && rm /tmp/rustup.sh

COPY scripts/docker/linux-build.sh /usr/local/bin/notemd-linux-build
WORKDIR /build
# Mount the two /input siblings read-only; use separate per-architecture volumes
# for /usr/local/cargo/registry, /usr/local/cargo/git and /cache/target.
ENTRYPOINT ["/usr/local/bin/notemd-linux-build"]
