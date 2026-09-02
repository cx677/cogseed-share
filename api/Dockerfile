FROM node:20-alpine AS build
WORKDIR /app
COPY api/package*.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY api/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Web 分享页（server.ts 从 ../../web 读取，dist 在 /app/dist → web 在 /app/web）
COPY web ./web
EXPOSE 3000
CMD ["node", "dist/server.js"]
