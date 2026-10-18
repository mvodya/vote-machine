# Common container toolchain for web & api development
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build git ca-certificates curl \
    libjsoncpp-dev libssl-dev zlib1g-dev uuid-dev libpq-dev libc-ares-dev \
    clang-format clangd gdb libcmark-gfm-dev \
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

# Tools shared by local and CI checks
FROM toolchain AS test_tools
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends clang-tidy libgtest-dev \
    && rm -rf /var/lib/apt/lists/*
# For devcontainer (api & web)
FROM test_tools AS dev
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libjxl-tools && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.25.0 --registry=https://registry.npmjs.org
WORKDIR /workspace

# For building API app
FROM test_tools AS build
WORKDIR /src
COPY apps/api/ .
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel 2 \
    && ctest --test-dir build --output-on-failure

# API runtime
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjsoncpp25 libssl3 zlib1g libuuid1 libpq5 libc-ares2 libcmark-gfm0.29.0.gfm.6 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home vote_machine
COPY --from=build /src/build/vote_machine_api /usr/local/bin/vote_machine_api
WORKDIR /home/vote_machine
USER vote_machine
EXPOSE 8080
CMD ["vote_machine_api"]

# Instrument application code and run its unit tests
FROM test_tools AS sanitize
WORKDIR /src
COPY apps/api/ .
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug \
      -DVOTE_MACHINE_SANITIZERS=ON \
    && cmake --build build --parallel 2 \
    && ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
      UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
      ctest --test-dir build --output-on-failure

FROM runtime AS sanitize-runtime
USER root
COPY --from=sanitize /usr/lib/*-linux-gnu/libasan.so.8 /usr/lib/*-linux-gnu/libubsan.so.1 /usr/local/lib/
RUN ldconfig
COPY --from=sanitize /src/build/vote_machine_api /usr/local/bin/vote_machine_api
ENV ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
    UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1
USER vote_machine

# Keep the default build as the release runtime
FROM runtime AS release
