# Use official Node.js LTS image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first (for caching dependencies)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Expose port for Render
EXPOSE 10000

# Start the bot
CMD ["node", "index.js"]
