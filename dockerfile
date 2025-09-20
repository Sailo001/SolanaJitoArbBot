# Use Node.js 18 LTS slim image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the app
COPY . .

# Expose port for healthcheck
EXPOSE 10000

# Start the bot
CMD ["node", "index.js"]
