# Use Node.js LTS
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package.json first for caching
COPY package.json ./

# Install dependencies
RUN npm install --only=prod

# Copy rest of the code
COPY . .

# Expose port for webhook
EXPOSE 10000

# Start the bot
CMD ["npm", "start"]
