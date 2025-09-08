FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install               # <-- change here
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/index.js"]
