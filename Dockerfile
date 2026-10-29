FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/storage/uploads
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY public ./public
COPY src/demo ./dist/demo
RUN chown -R node:node /app
USER node
EXPOSE 4317
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
