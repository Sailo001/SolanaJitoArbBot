# 1. build stage (dummy first)
FROM rust:1.73-slim AS builder
WORKDIR /app
# copy manifests first
COPY Cargo.toml Cargo.lock ./
# create dummy main.rs so cargo can build
RUN mkdir src && echo 'fn main() { println!("dummy"); }' > src/main.rs
RUN cargo build --release
# now copy real source & rebuild only what changed
COPY . .
RUN touch src/main.rs && cargo build --release --bin solana-arb-detector

# 2. tiny runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/solana-arb-detector /usr/local/bin/solana-arb-detector
ENV RUST_LOG=info
CMD ["solana-arb-detector"]
