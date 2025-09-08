FROM node:20-alpine
RUN apk add --no-cache git openssh-client
WORKDIR /app
# tell npm to use HTTPS, not SSH
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/index.js"]
