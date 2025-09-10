# Use Node.js LTS
FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Copy package.json
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy app source
COPY . .

# Expose Render port
EXPOSE 3000

# Start bot
CMD ["npm", "start"]
