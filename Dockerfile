FROM node:20-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --only=production
COPY . .
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "index.js"]
