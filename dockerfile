# Use Node.js 18 LTS
FROM node:18

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose port for healthcheck
EXPOSE 10000

# Start the bot
CMD ["node", "index.js"]
