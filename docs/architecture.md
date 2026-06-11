# TriCore Agent 架构设计文档

## 1. 设计哲学

### 核心原则：三条铁律

```
意识不碰手 → 意识核只建议，不执行
执行不经脑 → 执行核按流程闭环，不经模糊推理
进化受约束 → 自动沉淀技能需审计才能激活
```

### 核心理念：三核融合

不同于单一LLM Agent，TriCore将智能体拆分为三个专业化核心，各司其职又通过治理层协同工作。

## 2. 系统架构

### 2.1 分层架构

```
┌────────────────────────────────────────────┐
│              Application Layer              │
│  API Server  │  Social Dispatch  │  Voice   │
├────────────────────────────────────────────┤
│               Extension Layer               │
│  Browser Automation  │  Plugins  │  Tools  │
├────────────────────────────────────────────┤
│                 Core Layer                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │Conscious-│ │Execution │ │Evolution │   │
│  │ness Core │ │  Core    │ │  Core    │   │
│  └──────────┘ └──────────┘ └──────────┘   │
├────────────────────────────────────────────┤
│            Governance Layer                 │
│  ┌────────┐ ┌──────────┐ ┌──────────┐    │
│  │CoreBus │ │Security  │ │Budget    │    │
│  └────────┘ └──────────┘ └──────────┘    │
│  ┌──────────────────────────────────┐     │
│  │        Model Router              │     │
│  └──────────────────────────────────┘     │
├────────────────────────────────────────────┤
│          Infrastructure Layer              │
│  Memory Engine  │  Scheduler  │  Logger   │
├────────────────────────────────────────────┤
│          Enterprise Layer                  │
│  RBAC  │  Audit  │  Encryption            │
└────────────────────────────────────────────┘
```

### 2.2 治理层详解

#### CoreBus（核心总线）
- **统一事件通道**：所有核之间的通信通过总线
- **关联ID追踪**：每个操作链都有traceId
- **事件优先级**：CRITICAL > HIGH > NORMAL > LOW
- **调试探针**：可注入事件监听器进行调试

#### SecurityBoundary（安全边界）
- **三条铁律强制执行**
- **跨核授权网关**：每个核的能力矩阵
- **路径遍历防护**
- **Shell命令白名单**
- **Prompt注入检测**

#### TokenBudgetManager（Token预算）
- **三层预算**：意识60% / 执行30% / 进化10%
- **自动节流**：NONE → LIGHT → MODERATE → HEAVY → EMERGENCY
- **缓存策略**：EXACT / PREFIX / SIMILAR
- **自适应调整**：每5分钟根据使用率调整

### 2.3 三核设计

#### 意识核（Consciousness Core）
- **TICK循环引擎**：10s觉醒期 → 30s任务活跃 → 5min意识 → 10min进化 → 20min空闲
- **双层思考**：L1快速响应（简单问答）/ L2深度处理（复杂分析）
- **焦点栈**：基于关键词的语义级话题切换，最大深度4
- **记忆注入器**：FTS5+向量双路召回 + 时间词解析 + 技能路由
- **系统提示词**：Stable（命中Cache）+ Dynamic（每轮重建）

#### 执行核（Execution Core）
- **任务闭环**：Pending → Planning → Executing → Verifying → Completed/Failed
- **安全沙箱**：所有文件操作限制在sandbox目录
- **自动重试**：最多3次，指数退避
- **插件生态**：installPlugin / uninstallPlugin / listPlugins
- **操作审计**：每步操作记录执行轨迹

#### 进化核（Evolution Core）
- **技能沉淀引擎**：LLM驱动从执行轨迹提取可复用技能
- **SKILL.md标准**：开放格式，可搜索/可分享/可移植
- **技能审计**：pending → approved/rejected，安全类别自动批准
- **记忆整合**：衰减 + 去重 + 降级 + 淘汰
- **轨迹分析**：统计成功率/耗时，生成改进建议

## 3. 数据流

### 3.1 用户消息处理流程

```
User Message
    │
    ▼
SecurityBoundary: 输入消毒（Prompt注入防护）
    │
    ▼
ConsciousnessCore: 判断思考层级（L1/L2）
    │
    ▼
MemoryEngine: 记忆注入（FTS5 + 向量双路召回）
    │
    ▼
FocusStack: 焦点栈更新（话题切换判定）
    │
    ▼
SkillSearch: 搜索相关技能
    │
    ▼
ModelRouter: 选择最优Provider → LLM调用
    │
    ▼
BudgetManager: 报告Token使用量
    │
    ▼
BackgroundRecognize: 异步记忆写入
    │
    ▼
CoreBus: 发布事件（task_request / skill_extract等）
```

### 3.2 任务执行流程

```
submitTask(goal)
    │
    ▼
SecurityBoundary: 授权检查（意识核只能"建议"）
    │
    ▼
TokenBudget: 预算检查（execution池）
    │
    ▼
ExecutionCore.createTask: 创建任务 → 进入PLANNING
    │
    ▼
LLM规划: 拆解为步骤序列（JSON输出）
    │
    ▼
executeStep（循环）:
    ├── 安全检查（SecurityBoundary）
    ├── 危险操作确认（PAUSED等待）
    ├── 执行操作（重试最多3次）
    ├── 记录轨迹（ExecutionTraces表）
    └── 审计日志
    │
    ▼
task_completed → EvolutionCore.extractSkillFromTask
    │
    ▼
技能沉淀（pending状态 → 等待审计）
```

## 4. 安全架构

### 4.1 认证与授权

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  用户请求    │────▶│ JWT验证      │────▶│ RBAC权限检查 │
│ (Token/Key) │     │ +IP绑定      │     │ +临时授权    │
└─────────────┘     └──────────────┘     └──────────────┘
```

### 4.2 数据安全

- **传输**：API Key + JWT Token双模式
- **存储**：AES-256-GCM加密，密钥轮转
- **完整性**：HMAC-SHA256签名
- **脱敏**：自动识别并脱敏敏感数据（密码/API Key/手机/邮箱等）

### 4.3 运行时安全

- **沙箱隔离**：文件操作限制在指定目录
- **路径遍历防护**：解析路径必须在沙箱内
- **Shell安全**：白名单命令 + 元字符检测 + execFile参数化
- **Prompt注入防护**：输入消毒 + 注入特征检测
- **异常检测**：暴力破解检测 + 严重事件激增检测

## 5. 记忆系统

### 5.1 五层记忆模型

| 层级 | 名称 | 条件 | 用途 |
|------|------|------|------|
| L0 | 热记忆(Hot) | salience ≥ 5, age < 7天 | 每轮注入 |
| L1 | 温记忆(Warm) | salience ≥ 3, age < 30天 | 按需召回 |
| L2 | 冷记忆(Cold) | salience < 3 或 age ≥ 30天 | 仅关键词/向量命中 |
| L3 | 执行记忆(Exec) | 任务执行轨迹 | 技能沉淀源 |
| L4 | 技能记忆(Skill) | SKILL.md标准 | 可复用知识 |

### 5.2 双路召回

```
查询文本
    │
    ├──▶ FTS5全文搜索（trigram，支持中文）
    │       ├── 关键词提取（2-4 gram）
    │       └── 排名合并
    │
    └──▶ 向量嵌入搜索
            ├── embedding计算
            └── 余弦相似度排序
    │
    ▼
合并去重 → 衰减调整 → 排序返回
```

### 5.3 记忆生命周期

```
写入 → 衰减（每日-0.1）→ 整合（去重/合并）→ 降级（hot→warm→cold）→ 淘汰（超限删除）
```

## 6. 扩展性设计

### 6.1 Provider路由

支持多Provider同时注册，按用途分池路由：

```
┌─────────────────────────────────────────┐
│              Model Router                │
│                                          │
│  consciousness → GPT-4 / Claude Opus    │
│  execution     → GPT-4o / Claude Sonnet │
│  evolution     → DeepSeek / GPT-4o-mini │
│  embedding     → text-embedding-3-small  │
│  vision        → GPT-4V / Claude Vision │
└─────────────────────────────────────────┘
```

### 6.2 插件系统

```javascript
// 注册插件
agent.installPlugin({
  name: 'code-reviewer',
  version: '1.0.0',
  tools: [
    {
      name: 'review_code',
      definition: { /* tool definition */ },
      handler: async (params, ctx) => { /* tool logic */ }
    }
  ]
});
```

### 6.3 技能市场

- 发布：`agent.publishSkill(skill)`
- 搜索：`agent.searchMarketSkills(query)`
- 下载：`agent.downloadSkill(skillId)`
- 评分：`agent.rateSkill(skillId, rating)`
