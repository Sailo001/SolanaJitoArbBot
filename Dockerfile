# Use official Node.js LTS
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (to leverage Docker cache)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --omit=dev

# Copy app source
COPY . .

# Expose port (match your index.js PORT)
EXPOSE 10000

# Start the bot
CMD ["npm", "start"]
