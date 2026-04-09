FROM node:22-alpine

WORKDIR /app

RUN npm install -g pnpm@10

COPY package.json ./
RUN npm install

COPY . .

RUN node build.mjs

EXPOSE 8080

CMD ["node", "dist/index.mjs"]
