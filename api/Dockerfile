# node:20-slim（Debian glibc）——fastembed tokenizer 支持 linux-arm64-gnu
# （alpine/musl 的 tokenizers 无 arm64-musl 包，本地 embedding 无法在 alpine 跑）
FROM node:20-slim AS build
WORKDIR /app
COPY api/package*.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY api/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Web 分享页
COPY web ./web
EXPOSE 3000
CMD ["node", "dist/server.js"]
