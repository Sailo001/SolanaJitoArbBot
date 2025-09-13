# Use a small Node image
FROM node:18-slim

# Create app dir
WORKDIR /usr/src/app

# Install system deps (if any)
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy package manifest first (leverages Docker cache)
COPY package.json package-lock.json* ./

# Install dependencies (production)
RUN npm ci --production

# Copy the rest of the app
COPY . .

# Expose port
EXPOSE 10000

# Run
CMD ["node", "index.js"]
