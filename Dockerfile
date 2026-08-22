# ---------- 构建阶段：安装全部依赖并编译 ----------
FROM node:22-alpine AS builder
WORKDIR /app

# 先复制 lockfile，充分利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------- 运行阶段：仅生产依赖 + 编译产物 ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main"]
