# Railway runs linux/amd64 -- build with `./build-push.sh` (buildx --platform
# linux/amd64). A native arm64 build dies with "Exec format error" on the base
# image's docker-entrypoint.sh and the domain 502s.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
