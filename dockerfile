# 1. build stage (stripped)
FROM rust:1.73-slim AS builder
WORKDIR /app
# cache dependencies – copy BOTH files
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main(){}" > src/main.rs
RUN cargo build --release && rm -rf src
# now copy real source
COPY . .
RUN touch src/main.rs && cargo build --release --bin solana-arb-detector

# 2. tiny runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/solana-arb-detector /usr/local/bin/solana-arb-detector
ENV RUST_LOG=info
CMD ["solana-arb-detector"]
