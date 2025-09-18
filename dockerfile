FROM rust:1.73-slim
WORKDIR /app
COPY . .
RUN cargo build --release
ENV RUST_LOG=info
CMD ["./target/release/solana-arb-detector"]
