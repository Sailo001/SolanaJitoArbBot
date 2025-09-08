FROM node:20-alpine
RUN apk add --no-cache git     # <-- add this
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/index.js"]
