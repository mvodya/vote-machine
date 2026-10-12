# Common container toolchain for web & api development
FROM node:24.15.0-bookworm-slim AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build git ca-certificates curl \
    libjsoncpp-dev libssl-dev zlib1g-dev uuid-dev libpq-dev libc-ares-dev \
    libgtest-dev \
    clang-format clangd gdb \
    && rm -rf /var/lib/apt/lists/*

# Install Drogon library
ARG DROGON_COMMIT=4c5430757ea5451a7c38fbbef4b4bef7dbb47f2f
RUN git clone https://github.com/drogonframework/drogon.git /opt/drogon \
    && cd /opt/drogon && git checkout "$DROGON_COMMIT" \
    && git submodule update --init --recursive \
    && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_EXAMPLES=OFF -DBUILD_CTL=OFF -DBUILD_TESTING=OFF \
      -DBUILD_BROTLI=OFF -DBUILD_YAML_CONFIG=OFF -DBUILD_MYSQL=OFF \
      -DBUILD_SQLITE3=OFF -DBUILD_REDIS=OFF \
    && cmake --build build --parallel 2 \
    && cmake --install build

# For devcontainer (api & web)
FROM toolchain AS dev
# Install pnp
RUN npm install --global pnpm@11.25.0 --registry=https://registry.npmjs.org
WORKDIR /workspace

# For building API app
FROM toolchain AS build
WORKDIR /src
COPY apps/api/ .
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel 2 \
    && ctest --test-dir build --output-on-failure

# API runtime
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjsoncpp25 libssl3 zlib1g libuuid1 libpq5 libc-ares2 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home vote_machine
COPY --from=build /src/build/vote_machine_api /usr/local/bin/vote_machine_api
USER vote_machine
EXPOSE 8080
CMD ["vote_machine_api"]
