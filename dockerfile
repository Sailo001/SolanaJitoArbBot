# Use Node.js 18 LTS slim image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./ 

# Install dependencies
RUN npm install --production

# Copy the rest of the app
COPY . .

# Expose port for healthcheck / webhook
EXPOSE 10000

# Set environment variables (can also be set in Render dashboard)
ENV PORT=10000

# Start the bot
CMD ["node", "index.js"]
