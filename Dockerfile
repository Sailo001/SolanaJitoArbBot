FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --no-package-lock
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/index.js"]
