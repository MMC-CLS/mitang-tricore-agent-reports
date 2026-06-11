# TriCore Agent v1.0 — Docker 多阶段构建
# 生产级部署：原生模块编译 → 精简运行时镜像
#
# 构建: docker build -t mitang-tricore-agent:1.0.0 .
# 运行: docker run -p 3721:3721 -e LLM_API_KEY=xxx mitang-tricore-agent:1.0.0
# Compose: docker-compose up -d

# ── 阶段1: 构建依赖（编译 better-sqlite3 等原生模块） ──
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 仅复制依赖文件以利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci --production --ignore-scripts=false

# 复制源码
COPY src/ ./src/
COPY docs/ ./docs/
COPY scripts/ ./scripts/

# ── 阶段2: 生产镜像 ──
FROM node:20-slim

LABEL maintainer="TriCore Agent Team"
LABEL org.opencontainers.image.title="蜜糖 TriCore Agent"
LABEL org.opencontainers.image.description="三核融合智能体：意识(白龙马) + 执行(龙虾) + 进化(爱马仕) | v1.0"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.licenses="MIT"

# 安装运行时系统依赖（Playwright浏览器 + SQLite）
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Playwright 浏览器依赖
    libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2t64 libxshmfence1 \
    # SQLite 运行时
    libsqlite3-0 \
    # 健康检查
    curl \
    && rm -rf /var/lib/apt/lists/*

# 创建非root用户
RUN groupadd -r tricore && useradd -r -g tricore -d /app -s /sbin/nologin tricore

WORKDIR /app

# 复制构建产物
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/src ./src
COPY --from=builder /build/docs ./docs
COPY --from=builder /build/scripts ./scripts
COPY package.json ./
COPY CHANGELOG.md README.md* LICENSE* ./

# 创建运行时目录并设置权限
RUN mkdir -p /app/data/logs /app/data/audit /app/data/keys \
    /app/data/config /app/data/sandbox /app/data/subagents \
    /app/data/teams /app/data/skill_market /app/data/registry \
    && chown -R tricore:tricore /app

# 运行时环境变量
ENV NODE_ENV=production
ENV TRICORE_DATA_DIR=/app/data
ENV TRICORE_LOG_DIR=/app/data/logs
ENV TRICORE_ALLOW_LAN=0
ENV NODE_OPTIONS="--max-old-space-size=512"

# 暴露端口
# 3721: API服务
# 3722: 健康检查端点
EXPOSE 3721 3722

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:3722/health || curl -sf http://localhost:3721/status || exit 1

# 切换到非root用户
USER tricore

# 数据卷声明
VOLUME ["/app/data", "/app/data/logs"]

# 优雅启动
CMD ["node", "src/index.js"]

# 优雅停止信号
STOPSIGNAL SIGTERM
