# Use Node 18 LTS
FROM node:18

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first for caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the code
COPY . .

# Expose Render port
EXPOSE 10000

# Start the bot
CMD ["node", "index.js"]
