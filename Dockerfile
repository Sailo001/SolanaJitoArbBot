# Use Node.js LTS
FROM node:18

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies (without lockfile)
RUN npm install --omit=dev

# Copy source files
COPY . .

# Expose Render free-tier port
EXPOSE 10000

# Start the bot
CMD ["npm", "start"]
