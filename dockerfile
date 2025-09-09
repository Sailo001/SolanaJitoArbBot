# ---- build stage ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- run stage ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && apk add --no-cache tini
COPY --from=builder /app/dist ./dist
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
