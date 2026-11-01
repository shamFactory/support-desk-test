FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test

EXPOSE 4300 4301

CMD ["node", "src/server.mjs"]
