# Use official Node.js LTS
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json if available
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Expose port (match your index.js PORT)
EXPOSE 10000

# Healthcheck (optional, helps Render detect service is live)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -f http://localhost:10000/ || exit 1

# Start the bot
CMD ["npm", "start"]
