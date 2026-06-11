# TriCore Agent API 文档

## HTTP API

### 基础信息

- **默认地址**：`http://127.0.0.1:3721`
- **认证方式**：Bearer Token (JWT) 或 API Key Header
- **内容类型**：`application/json`

### 认证

```
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "your-password"
}

Response:
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresAt": 1700000000000,
  "user": {
    "id": "user_admin_default",
    "username": "admin",
    "roles": ["super_admin"]
  }
}
```

### 消息

```
POST /api/message
Authorization: Bearer <token>

{
  "content": "帮我分析这个项目的架构",
  "channel": "api",
  "priority": 1000
}

Response:
{
  "messageId": "msg_1700000000000_abc123",
  "status": "accepted"
}
```

### 任务

```
POST /api/tasks
Authorization: Bearer <token>

{
  "goal": "下载并分析example.com的数据",
  "context": { "url": "https://example.com" },
  "priority": "high"
}

Response:
{
  "taskId": "task_1700000000000_def456",
  "status": "pending"
}
```

### 记忆

```
GET /api/memories?query=数据分析&limit=10
Authorization: Bearer <token>

Response:
{
  "memories": [
    {
      "id": 1,
      "content": "...",
      "salience": 4.5,
      "tier": "warm",
      "effectiveSalience": 4.2
    }
  ]
}
```

### RAG

```
POST /api/rag/ask
Authorization: Bearer <token>

{
  "question": "TriCore的核心设计原则是什么？",
  "options": {
    "topK": 5,
    "mode": "hybrid"
  }
}

Response:
{
  "answer": "TriCore的核心设计原则是三条铁律...",
  "sources": [
    {
      "content": "...",
      "source": "README.md",
      "score": 0.85
    }
  ],
  "confidence": 0.85
}
```

### 多模态

```
POST /api/multimodal/analyze
Authorization: Bearer <token>
Content-Type: multipart/form-data

image: <file>
prompt: "描述这张图片的内容"

Response:
{
  "analysis": "这张图片显示...",
  "metadata": {
    "format": "png",
    "dimensions": "1024x768"
  }
}
```

### RBAC 用户管理

```
POST /api/rbac/users
Authorization: Bearer <token>

{
  "username": "new_user",
  "password": "secure_password",
  "roles": ["operator"]
}

Response:
{
  "id": "user_1700000000000_ghi789",
  "username": "new_user",
  "roles": ["operator"]
}
```

### 审计日志

```
GET /api/audit/logs?category=security&since=1700000000000&limit=50
Authorization: Bearer <token>

Response:
{
  "logs": [
    {
      "id": "audit_1700000000000_jkl012",
      "timestamp": 1700000000000,
      "level": "warn",
      "category": "security",
      "action": "login_failed",
      "userId": "unknown"
    }
  ],
  "total": 150
}
```

### 合规报告

```
POST /api/audit/report
Authorization: Bearer <token>

{
  "startDate": 1690000000000,
  "endDate": 1700000000000,
  "categories": ["security", "access"]
}

Response:
{
  "generatedAt": 1700000000000,
  "period": { "start": 1690000000000, "end": 1700000000000 },
  "summary": {
    "totalEvents": 5000,
    "byLevel": { "info": 4800, "warn": 150, "error": 40, "critical": 10 },
    "byCategory": { "security": 200, "access": 300 },
    "criticalEvents": [...]
  }
}
```

### 系统状态

```
GET /api/status
Authorization: Bearer <token>

Response:
{
  "version": "2.2.0",
  "codename": "TriCore",
  "running": true,
  "scheduler": {
    "mode": "consciousness",
    "tickCounter": 42
  },
  "budget": {
    "cores": {
      "consciousness": { "used": 15000, "limit": 30000 },
      "execution": { "used": 5000, "limit": 15000 },
      "evolution": { "used": 1000, "limit": 5000 }
    }
  }
}
```

## 事件流 (SSE)

### 实时事件

```
GET /api/events
Authorization: Bearer <token>
Accept: text/event-stream

event: tick
data: {"type":"consciousness","tickNumber":42,"mode":"consciousness"}

event: task_update
data: {"taskId":"task_xxx","status":"executing","currentStep":2}

event: skill_extracted
data: {"name":"auto_skill_task_xxx","category":"general","status":"pending"}

event: security_alert
data: {"type":"iron_law_violation","law":1,"message":"..."}

event: budget_warning
data: {"level":"heavy","usageRate":0.85}
```

## 编程接口

### 初始化

```javascript
const { TriCoreAgent } = require('tricore-agent');

const agent = new TriCoreAgent({
  dataDir: './data',
  name: 'MyAgent',
  // ... 更多配置
});

await agent.start({
  provider: 'deepseek',
  apiKey: process.env.LLM_API_KEY,
});
```

### 消息

```javascript
// 发送消息
const msgId = agent.sendMessage('user_id', '你好，帮我查一下今天的天气');

// 搜索记忆
const memories = agent.searchMemories('天气', 5);

// 搜索技能
const skills = agent.searchSkills('搜索', 3);
```

### 任务

```javascript
// 提交任务
const taskId = await agent.submitTask('分析项目结构', {
  directory: '/path/to/project',
});

// 安装插件
agent.installPlugin(myPlugin);

// 浏览器操作
const result = await agent.browserAction('navigate', { url: 'https://example.com' });
```

### RAG

```javascript
// 添加文档
const docId = await agent.addDocument({
  content: 'TriCore是一个三核融合智能体...',
  title: '介绍',
});

// 加载文件
await agent.loadDocument('/path/to/doc.pdf');

// 检索
const results = await agent.ragRetrieve('三核架构', { topK: 5 });

// 问答
const answer = await agent.ragAsk('TriCore的核心设计原则是什么？');
```

### 多模态

```javascript
// 分析图像
const result = await agent.analyzeImage('/path/to/image.jpg', '描述这个图片');

// OCR识别
const text = await agent.ocr('/path/to/document.png', { language: 'eng' });

// 解析文档
const content = await agent.parseDocument('/path/to/report.pdf');

// 视觉问答
const answer = await agent.visualQA('/path/to/chart.png', '这张图显示的趋势是什么？');
```

### Tool Calling

```javascript
// 注册自定义工具
agent.registerTool({
  name: 'my_analysis_tool',
  description: '执行自定义分析',
  parameters: {
    type: 'object',
    properties: {
      data: { type: 'string', description: '分析数据' },
      method: { type: 'string', enum: ['summary', 'detail'] }
    },
    required: ['data']
  }
});

// 执行工具
const result = await agent.executeTool({
  name: 'my_analysis_tool',
  arguments: { data: '...', method: 'summary' }
});
```

### 企业级功能

```javascript
// RBAC
const user = agent.createUser('john', 'password123', ['operator']);
const auth = agent.authenticate('john', 'password123');
const hasPerm = agent.hasPermission(user.id, 'task:execute');

// 加密
agent.initializeEncryption('master-password');
const encrypted = agent.encrypt('sensitive');
const decrypted = agent.decrypt(encrypted);

// 审计
agent.auditLog('access', 'file_read', { userId: 'john', resource: 'report.txt' });
const logs = await agent.queryAuditLogs({ userId: 'john', since: yesterday });
```
