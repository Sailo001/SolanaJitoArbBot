# Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy all files
COPY . .

# Expose port for Render
EXPOSE 10000

# Start the bot
CMD ["npm", "start"]
