# Use official Node.js LTS
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package files first (for caching)
COPY package.json package-lock.json* ./

# Install dependencies (omit dev for smaller image)
RUN npm install --omit=dev

# Copy all source files
COPY . .

# Expose the port the bot listens on
EXPOSE 10000

# Start the bot
CMD ["npm", "start"]
