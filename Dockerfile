FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY vendor-sim ./vendor-sim
COPY data ./data
COPY index.html ./
COPY css ./css
COPY js ./js

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server/index.js"]
