FROM node:20-alpine
RUN apk add --no-cache git
WORKDIR /app

# one-line rewrite: always use anon HTTPS instead of any SSH URL
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/index.js"]
