# TriCore Agent 部署指南

## 目录

- [环境要求](#环境要求)
- [本地部署](#本地部署)
- [Docker 部署](#docker-部署)
- [Docker Compose 部署](#docker-compose-部署)
- [生产环境配置](#生产环境配置)
- [安全加固](#安全加固)
- [监控与运维](#监控与运维)
- [故障排查](#故障排查)

---

## 环境要求

| 组件 | 最低版本 | 推荐版本 |
|------|----------|----------|
| Node.js | >= 18.0.0 | 20.x LTS |
| npm | >= 9.0.0 | 10.x |
| Docker（可选） | 24.0+ | 26.x |
| Docker Compose（可选） | v2.0+ | v2.24+ |

**系统支持**：Linux (x64/arm64)、macOS (x64/arm64)、Windows (x64)

---

## 本地部署

### 1. 克隆项目

```bash
git clone <repository-url> TriCoreAgent
cd TriCoreAgent
```

### 2. 安装依赖

```bash
npm ci --production
```

> 开发环境请使用 `npm install` 以安装 devDependencies（ESLint、c8 等）。

### 3. 配置环境变量

创建 `.env` 文件：

```bash
# ── 必填配置 ──
LLM_API_KEY=your-api-key-here
LLM_PROVIDER=deepseek          # deepseek | openai | custom

# ── 安全配置 ──
TRICORE_ADMIN_PASSWORD=your-secure-admin-password
TRICORE_API_TOKEN=optional-shared-token
TRICORE_ENCRYPTION_KEY=optional-master-encryption-key

# ── 可选：多 Provider ──
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_BASE_URL=https://api.openai.com/v1

# ── 可选：自定义 LLM ──
CUSTOM_LLM_URL=http://localhost:11434/v1
CUSTOM_LLM_MODEL=llama3
```

### 4. 启动服务

```bash
# 生产模式
npm start

# 开发模式（文件变更自动重启）
npm run dev
```

服务默认监听 `http://127.0.0.1:3721`。

### 5. 验证部署

```bash
curl http://127.0.0.1:3721/status
# {"status":"running","version":"2.2.0","uptime":12345}
```

---

## Docker 部署

### 构建镜像

```bash
# 基础构建
docker build -t tricore-agent .

# 指定平台构建
docker build --platform linux/amd64 -t tricore-agent .

# 使用 BuildKit 加速
DOCKER_BUILDKIT=1 docker build -t tricore-agent .
```

### 运行容器

```bash
docker run -d \
  --name tricore-agent \
  --restart unless-stopped \
  -p 3721:3721 \
  -e LLM_API_KEY="your-api-key" \
  -e LLM_PROVIDER="deepseek" \
  -e TRICORE_ADMIN_PASSWORD="secure-password" \
  -e NODE_ENV=production \
  -v tricore-data:/app/data \
  -v tricore-logs:/app/logs \
  tricore-agent
```

### 常用管理命令

```bash
# 查看日志
docker logs -f tricore-agent

# 查看最近 100 行
docker logs --tail 100 tricore-agent

# 进入容器
docker exec -it tricore-agent sh

# 停止
docker stop tricore-agent

# 重启
docker restart tricore-agent

# 删除（含数据卷）
docker rm -f tricore-agent
docker volume rm tricore-data tricore-logs
```

### 资源限制

```bash
docker run -d \
  --name tricore-agent \
  --memory="512m" \
  --memory-swap="1g" \
  --cpus="1.5" \
  --restart unless-stopped \
  -p 3721:3721 \
  -e LLM_API_KEY="your-key" \
  tricore-agent
```

---

## Docker Compose 部署

### 基本启动

```bash
# 创建 .env 文件配置环境变量
cat > .env << 'EOF'
LLM_API_KEY=your-api-key
LLM_PROVIDER=deepseek
TRICORE_ADMIN_PASSWORD=secure-password
TRICORE_PORT=3721
TRICORE_ALLOW_LAN=0
TRICORE_API_TOKEN=
EOF

# 启动
docker-compose up -d

# 查看状态
docker-compose ps

# 查看日志
docker-compose logs -f
```

### 多实例部署

```yaml
# docker-compose.multi.yml
version: '3.8'

services:
  tricore-prod:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: tricore-prod
    restart: unless-stopped
    ports:
      - "3721:3721"
    environment:
      - NODE_ENV=production
      - LLM_PROVIDER=deepseek
      - LLM_API_KEY=${LLM_API_KEY}
      - TRICORE_DATA_DIR=/app/data
    volumes:
      - tricore-prod-data:/app/data
      - tricore-prod-logs:/app/logs

  tricore-dev:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: tricore-dev
    restart: unless-stopped
    ports:
      - "3722:3721"
    environment:
      - NODE_ENV=development
      - LLM_PROVIDER=openai
      - LLM_API_KEY=${OPENAI_API_KEY}
      - TRICORE_DATA_DIR=/app/data
    volumes:
      - tricore-dev-data:/app/data
      - tricore-dev-logs:/app/logs

volumes:
  tricore-prod-data:
  tricore-prod-logs:
  tricore-dev-data:
  tricore-dev-logs:
```

### 带反向代理部署

```yaml
# docker-compose.proxy.yml
version: '3.8'

services:
  tricore:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: tricore-agent
    restart: unless-stopped
    expose:
      - "3721"
    environment:
      - NODE_ENV=production
      - LLM_API_KEY=${LLM_API_KEY}
      - LLM_PROVIDER=${LLM_PROVIDER:-deepseek}
    volumes:
      - tricore-data:/app/data
      - tricore-logs:/app/logs
    networks:
      - tricore-net

  nginx:
    image: nginx:alpine
    container_name: tricore-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - tricore
    networks:
      - tricore-net

volumes:
  tricore-data:
  tricore-logs:

networks:
  tricore-net:
    driver: bridge
```

对应的 `nginx.conf`：

```nginx
events {
    worker_connections 1024;
}

http {
    upstream tricore_backend {
        server tricore:3721;
    }

    server {
        listen 80;
        server_name your-domain.com;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name your-domain.com;

        ssl_certificate /etc/nginx/certs/fullchain.pem;
        ssl_certificate_key /etc/nginx/certs/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;

        # SSE 流式支持
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;

        location / {
            proxy_pass http://tricore_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # 限制管理接口访问
        location /api/admin/ {
            allow 10.0.0.0/8;
            allow 172.16.0.0/12;
            allow 192.168.0.0/16;
            deny all;
            proxy_pass http://tricore_backend;
        }
    }
}
```

---

## 生产环境配置

### 系统服务（systemd）

创建 `/etc/systemd/system/tricore-agent.service`：

```ini
[Unit]
Description=TriCore Agent Service
Documentation=https://github.com/your-org/tricore-agent
After=network.target

[Service]
Type=simple
User=tricore
Group=tricore
WorkingDirectory=/opt/tricore-agent
Environment=NODE_ENV=production
Environment=LLM_API_KEY=your-api-key
Environment=LLM_PROVIDER=deepseek
Environment=TRICORE_DATA_DIR=/opt/tricore-agent/data
Environment=TRICORE_LOG_DIR=/opt/tricore-agent/logs
ExecStart=/usr/bin/node /opt/tricore-agent/src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tricore-agent

# 安全加固
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/tricore-agent/data /opt/tricore-agent/logs
ReadOnlyPaths=/opt/tricore-agent/src /opt/tricore-agent/node_modules

# 资源限制
MemoryMax=1G
CPUQuota=200%
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo useradd -r -s /sbin/nologin tricore
sudo mkdir -p /opt/tricore-agent/{data,logs}
sudo chown -R tricore:tricore /opt/tricore-agent
sudo systemctl daemon-reload
sudo systemctl enable tricore-agent
sudo systemctl start tricore-agent
sudo systemctl status tricore-agent
```

### 日志管理（logrotate）

创建 `/etc/logrotate.d/tricore-agent`：

```
/opt/tricore-agent/logs/*.log {
    daily
    rotate 30
    missingok
    notifempty
    compress
    delaycompress
    dateext
    dateformat -%Y%m%d
    maxsize 100M
    postrotate
        /bin/systemctl reload tricore-agent > /dev/null 2>&1 || true
    endscript
}
```

---

## 安全加固

### 最小权限原则

```bash
# Docker 非 root 运行（Dockerfile 已内置）
# 检查运行用户
docker exec tricore-agent whoami  # 应输出 tricore

# 限制容器能力
docker run --cap-drop=ALL --cap-add=NET_BIND_SERVICE ...
```

### 网络隔离

```bash
# 仅监听本地
export TRICORE_HOST=127.0.0.1

# 允许局域网（谨慎使用）
export TRICORE_ALLOW_LAN=1

# Docker 内部网络
docker network create tricore-isolated
docker run --network tricore-isolated ...
```

### 密钥管理

```bash
# 使用 Docker Secrets（Swarm 模式）
echo "your-api-key" | docker secret create llm_api_key -
docker service create \
  --secret llm_api_key \
  -e LLM_API_KEY_FILE=/run/secrets/llm_api_key \
  tricore-agent

# 使用文件挂载（非 Swarm）
echo "your-api-key" > ./secrets/llm_api_key.txt
chmod 600 ./secrets/llm_api_key.txt
docker run -v ./secrets/llm_api_key.txt:/run/secrets/llm_api_key:ro ...
```

### 防火墙配置

```bash
# UFW（Ubuntu/Debian）
sudo ufw allow from 10.0.0.0/8 to any port 3721
sudo ufw allow from 172.16.0.0/12 to any port 3721
sudo ufw allow from 192.168.0.0/16 to any port 3721
sudo ufw enable

# iptables
sudo iptables -A INPUT -p tcp --dport 3721 -s 10.0.0.0/8 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3721 -s 192.168.0.0/16 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3721 -j DROP
```

---

## 监控与运维

### 健康检查

```bash
# HTTP 健康检查
curl -f http://localhost:3721/status
# {"status":"running","version":"2.2.0","uptime":123456}

# 详细状态
curl http://localhost:3721/status/detailed
# {"status":"running","cores":{...},"memory":{"entries":42},"budget":{"remaining":45000}}
```

### 资源监控

```bash
# Docker 资源使用
docker stats tricore-agent

# 容器内进程
docker exec tricore-agent ps aux

# 磁盘使用
docker exec tricore-agent du -sh /app/data /app/logs
```

### 备份策略

```bash
# 数据目录备份
tar -czf tricore-backup-$(date +%Y%m%d).tar.gz /app/data/

# Docker 数据卷备份
docker run --rm \
  -v tricore-data:/data \
  -v $(pwd):/backup \
  alpine tar -czf /backup/tricore-data-backup.tar.gz -C /data .

# 自动化备份脚本（crontab）
0 2 * * * /opt/tricore-agent/scripts/backup.sh
```

### 日志查看

```bash
# 应用日志（本地）
tail -f /opt/tricore-agent/logs/app.log

# Docker 日志
docker logs -f --tail 200 tricore-agent

# systemd 日志
journalctl -u tricore-agent -f

# 过滤特定级别
docker logs tricore-agent 2>&1 | grep '"level":"ERROR"'
```

---

## 故障排查

### 启动失败

```bash
# 检查端口占用
lsof -i :3721
netstat -tulpn | grep 3721

# 检查 Node.js 版本
node --version  # 需要 >= 18.0.0

# 检查依赖
npm ls --depth=0

# 重建原生模块
npm rebuild better-sqlite3
```

### 内存问题

```bash
# 查看内存使用
docker stats --no-stream tricore-agent

# Node.js 堆内存限制
docker run -e NODE_OPTIONS="--max-old-space-size=512" ...

# 增加 Docker 内存限制
docker update --memory 2g --memory-swap 3g tricore-agent
```

### Token/API 问题

```bash
# 测试 LLM 连接
curl -H "Authorization: Bearer $LLM_API_KEY" \
  https://api.deepseek.com/v1/models

# 检查 Token 预算
curl http://localhost:3721/status/budget
```

### 数据库问题

```bash
# 数据目录权限
docker exec tricore-agent ls -la /app/data/
sudo chown -R tricore:tricore /opt/tricore-agent/data/

# 检查 SQLite 完整性
docker exec tricore-agent node -e "
  const db = require('better-sqlite3')('/app/data/tricore.db');
  console.log(db.pragma('integrity_check'));
"
```

### 日志级别调试

```bash
# 启用 DEBUG 日志
docker run -e TRICORE_LOG_LEVEL=debug ...

# 或修改 .env
TRICORE_LOG_LEVEL=debug
```

---

## 升级指南

### 从 v2.1 升级到 v2.2

```bash
# 1. 备份数据
tar -czf tricore-backup-$(date +%Y%m%d).tar.gz /app/data/

# 2. 拉取新版本
git pull origin main
npm ci --production

# 3. 检查配置变更
diff .env.example .env

# 4. 重启服务
sudo systemctl restart tricore-agent
# 或
docker-compose down && docker-compose up -d

# 5. 验证
curl http://localhost:3721/status
```

### 回滚

```bash
# systemd
sudo systemctl stop tricore-agent
tar -xzf tricore-backup-YYYYMMDD.tar.gz -C /
sudo systemctl start tricore-agent

# Docker
docker-compose down
docker tag tricore-agent:previous tricore-agent:latest
docker-compose up -d
```

---

## 性能调优

### Node.js 优化

```bash
# 启用垃圾回收日志
NODE_OPTIONS="--expose-gc --trace-gc-verbose"

# 调整堆大小
NODE_OPTIONS="--max-old-space-size=1024"

# 启用优化
NODE_OPTIONS="--optimize-for-size"
```

### 数据库优化

```bash
# SQLite WAL 模式（默认已启用）
# 检查：PRAGMA journal_mode;

# 定期清理
docker exec tricore-agent node -e "
  const db = require('better-sqlite3')('/app/data/tricore.db');
  db.pragma('optimize');
  db.pragma('vacuum');
"
```

### 并发调优

```javascript
// 在配置中调整
{
  maxConcurrentTasks: 5,        // 最大并发任务数
  toolTimeout: 30000,           // 工具超时（ms）
  ragParallelQueries: 3,        // RAG 并行查询数
  sessionTimeout: 3600000       // 会话超时（ms）
}
```

---

## 附录

### 完整环境变量列表

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `LLM_API_KEY` | 是 | - | LLM API 密钥 |
| `LLM_PROVIDER` | 否 | `deepseek` | LLM 提供商 |
| `OPENAI_API_KEY` | 否 | - | OpenAI API 密钥 |
| `ANTHROPIC_API_KEY` | 否 | - | Anthropic API 密钥 |
| `OPENAI_BASE_URL` | 否 | - | 自定义 API 端点 |
| `CUSTOM_LLM_URL` | 否 | - | 自定义 LLM URL |
| `CUSTOM_LLM_MODEL` | 否 | - | 自定义 LLM 模型名 |
| `TRICORE_HOST` | 否 | `127.0.0.1` | 监听地址 |
| `TRICORE_PORT` | 否 | `3721` | 监听端口 |
| `TRICORE_ALLOW_LAN` | 否 | `0` | 允许局域网访问 |
| `TRICORE_DATA_DIR` | 否 | `./data` | 数据目录 |
| `TRICORE_LOG_DIR` | 否 | `./logs` | 日志目录 |
| `TRICORE_LOG_LEVEL` | 否 | `info` | 日志级别 |
| `TRICORE_ADMIN_PASSWORD` | 否 | 随机生成 | 管理员密码 |
| `TRICORE_API_TOKEN` | 否 | - | 共享 API Token |
| `TRICORE_ENCRYPTION_KEY` | 否 | - | 主加密密钥 |
| `NODE_ENV` | 否 | `development` | 运行环境 |
| `NODE_OPTIONS` | 否 | - | Node.js 运行时选项 |
