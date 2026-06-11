/**
 * 蜜糖 TriCore Agent - 子智能体技能安装器 (SubAgentSkillInstaller)
 *
 * 核心职责：
 *   1. 技能文件解析 - 支持 .skill 文件 (SKILL.md标准) 和压缩包 (zip/tar.gz)
 *   2. 安全扫描 - 检测危险命令、恶意代码、安全漏洞
 *   3. 格式验证 - 验证 SKILL.md 格式规范
 *   4. 元数据提取 - 提取名称、描述、分类、触发关键词、依赖等
 *   5. 依赖解析 - 解析并验证技能声明的依赖项
 *   6. 版本管理 - 技能版本追踪与冲突检测
 *
 * SKILL.md 标准格式：
 *   # Skill Name
 *   > 简短描述 (one-liner)
 *
 *   ## Description
 *   详细描述...
 *
 *   ## Category
 *   analysis | automation | conversation | monitoring | custom
 *
 *   ## Trigger Keywords
 *   - keyword1
 *   - keyword2
 *
 *   ## Instructions
 *   技能指令/提示词...
 *
 *   ## Tools Required
 *   - tool_name1
 *   - tool_name2
 *
 *   ## Dependencies
 *   - dep_name: version
 *
 *   ## Version
 *   semver
 *
 *   ## Author
 *   作者信息
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ── 常量 ──

const SKILL_INSTALL_STATUS = Object.freeze({
  PENDING: 'pending',
  INSTALLING: 'installing',
  INSTALLED: 'installed',
  FAILED: 'failed',
  UPDATED: 'updated',
  REMOVED: 'removed',
});

const SKILL_PARSE_RESULT = Object.freeze({
  VALID: 'valid',
  WARNING: 'warning',
  INVALID: 'invalid',
});

const SKILL_FILE_EXTENSIONS = ['.skill', '.skill.md', '.md'];
const ARCHIVE_EXTENSIONS = ['.zip', '.tar.gz', '.tgz'];

const SKILL_CATEGORIES = [
  'analysis', 'automation', 'conversation',
  'monitoring', 'coding', 'data', 'creative',
  'research', 'custom',
];

// ── 安全扫描模式 ──

const DANGEROUS_PATTERNS = [
  // 文件系统破坏
  { pattern: /rm\s+-rf\s+\//i, severity: 'critical', desc: '递归删除根目录' },
  { pattern: /rm\s+-rf\s+\*/i, severity: 'critical', desc: '递归删除所有文件' },
  { pattern: /del\s+\/[sq]\s+\*\.\*/i, severity: 'critical', desc: '强制删除系统文件' },
  { pattern: /format\s+[c-z]:/i, severity: 'critical', desc: '格式化磁盘' },
  { pattern: /dd\s+if=/i, severity: 'critical', desc: '磁盘覆写操作' },

  // 进程/系统控制
  { pattern: /shutdown\s+-/i, severity: 'high', desc: '系统关机命令' },
  { pattern: /reboot/i, severity: 'high', desc: '系统重启命令' },
  { pattern: /killall\s+-9/i, severity: 'high', desc: '强制终止所有进程' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, severity: 'critical', desc: 'Fork炸弹' },

  // 代码注入
  { pattern: /eval\s*\(/i, severity: 'high', desc: '动态代码执行' },
  { pattern: /Function\s*\(/i, severity: 'high', desc: '动态函数构造' },
  { pattern: /child_process/i, severity: 'high', desc: '子进程调用' },
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/i, severity: 'high', desc: '引入子进程模块' },

  // 网络危险操作
  { pattern: /curl.*\|.*(?:ba)?sh/i, severity: 'critical', desc: '远程脚本管道执行' },
  { pattern: /wget.*-O-.*\|.*(?:ba)?sh/i, severity: 'critical', desc: '远程脚本管道执行' },
  { pattern: /nc\s+-[lL]/i, severity: 'high', desc: 'Netcat监听模式' },

  // 权限提升
  { pattern: /chmod\s+777/i, severity: 'high', desc: '开放全部权限' },
  { pattern: /sudo\s/i, severity: 'medium', desc: '超级用户权限' },
  { pattern: /chown\s+root/i, severity: 'high', desc: '更改所有者为root' },

  // 数据泄露
  { pattern: /\.env/i, severity: 'medium', desc: '访问环境变量文件' },
  { pattern: /\/etc\/passwd/i, severity: 'high', desc: '访问密码文件' },
  { pattern: /\/etc\/shadow/i, severity: 'critical', desc: '访问影子密码文件' },
  { pattern: /\.ssh\//i, severity: 'high', desc: '访问SSH密钥' },

  // 持久化后门
  { pattern: /crontab\s+-/i, severity: 'high', desc: '修改定时任务' },
  { pattern: /systemctl\s+enable/i, severity: 'high', desc: '启用系统服务' },
  { pattern: /\/etc\/rc\.local/i, severity: 'high', desc: '修改启动脚本' },
];

// ── 技能安装器类 ──

class SubAgentSkillInstaller extends EventEmitter {
  constructor(options = {}) {
    super();

    this._logger = options.logger || console;
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data', 'subagents');
    this._memoryEngine = options.memoryEngine || null;  // MemoryEngine引用（用于技能记忆层）
    this._guardian = options.guardian || null;            // 安全守护引用

    // 安装历史
    this._installHistory = new Map();  // agentId → [{skillId, name, version, installedAt, status}]
    this._skillStore = new Map();      // agentId → Map(skillId → skillObject)

    // 安全白名单（子智能体ID → 允许的操作列表）
    this._safetyWhitelist = new Map();

    // 确保数据目录
    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir, { recursive: true });
    }
  }

  // ═══════════════════════════════════════
  // 技能文件解析
  // ═══════════════════════════════════════

  /**
   * 从文件路径安装技能
   * @param {string} agentId - 目标子智能体ID
   * @param {string} filePath - 技能文件路径 (.skill/.skill.md/.zip/.tar.gz)
   * @param {object} options - { force?, autoApprove? }
   */
  async installFromFile(agentId, filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `技能文件不存在: ${filePath}` };
    }

    const ext = path.extname(filePath).toLowerCase();
    const baseName = path.basename(filePath).toLowerCase();

    try {
      let skillData;

      // 判断文件类型
      if (baseName.endsWith('.tar.gz') || baseName.endsWith('.tgz')) {
        skillData = await this._extractArchive(filePath, 'tar.gz');
      } else if (ext === '.zip') {
        skillData = await this._extractArchive(filePath, 'zip');
      } else if (SKILL_FILE_EXTENSIONS.some(e => baseName.endsWith(e))) {
        skillData = this._parseSkillFile(filePath);
      } else {
        // 尝试作为文本文件解析
        skillData = this._parseSkillFile(filePath);
      }

      if (!skillData) {
        return { success: false, error: '无法解析技能文件，请检查格式' };
      }

      return this.installSkill(agentId, skillData, options);

    } catch (error) {
      this._logger.error(`[SkillInstaller] 技能安装失败: ${error.message}`);
      return { success: false, error: `安装失败: ${error.message}` };
    }
  }

  /**
   * 从原始内容安装技能
   * @param {string} agentId - 目标子智能体ID
   * @param {string} content - 技能内容（SKILL.md格式文本）
   * @param {object} options
   */
  installFromContent(agentId, content, options = {}) {
    if (!content || content.trim().length === 0) {
      return { success: false, error: '技能内容不能为空' };
    }

    const skillData = this._parseSkillContent(content);
    if (!skillData) {
      return { success: false, error: '无法解析技能内容，请检查SKILL.md格式' };
    }

    return this.installSkill(agentId, skillData, options);
  }

  /**
   * 从技能市场安装（下载并安装）
   * @param {string} agentId
   * @param {object} marketSkill - 技能市场中的技能对象
   * @param {object} options
   */
  installFromMarket(agentId, marketSkill, options = {}) {
    if (!marketSkill || !marketSkill.content) {
      return { success: false, error: '无效的市场技能数据' };
    }

    const skillData = this._parseSkillContent(marketSkill.content);
    if (!skillData) {
      // 回退：用市场元数据构建
      skillData = {
        name: marketSkill.name,
        description: marketSkill.description || '',
        category: marketSkill.category || 'custom',
        instructions: marketSkill.content,
        version: marketSkill.version || '1.0.0',
        author: marketSkill.authorId || 'market',
        content: marketSkill.content,
        marketSkillId: marketSkill.skillId,
      };
    }

    return this.installSkill(agentId, skillData, options);
  }

  // ═══════════════════════════════════════
  // 核心安装逻辑
  // ═══════════════════════════════════════

  /**
   * 安装技能到子智能体
   */
  installSkill(agentId, skillData, options = {}) {
    const { force = false, autoApprove = false, skipSafety = false } = options;

    // 1. 格式验证
    const validation = this._validateSkillData(skillData);
    if (validation.status === SKILL_PARSE_RESULT.INVALID) {
      return {
        success: false,
        error: `技能格式无效: ${validation.issues.join('; ')}`,
        validation,
      };
    }

    // 2. 安全检查（除非明确跳过）
    if (!skipSafety) {
      const safetyResult = this._safetyCheck(skillData);
      if (!safetyResult.safe) {
        if (!autoApprove) {
          return {
            success: false,
            error: `安全扫描未通过: ${safetyResult.threats.map(t => t.desc).join('; ')}`,
            safetyResult,
            requireApproval: true,
          };
        }
        // 自动批准模式下仍记录警告
        this._logger.warn(`[SkillInstaller] 自动批准有安全警告的技能: ${skillData.name} - ${safetyResult.threats.map(t => t.desc).join(', ')}`);
      }
    }

    // 3. 生成技能ID
    const skillId = skillData.id || `sk_${crypto.createHash('sha256')
      .update(`${skillData.name}_${skillData.version || '1.0.0'}_${agentId}`)
      .digest('hex').substring(0, 12)}`;

    // 4. 版本冲突检测
    const existingSkill = this._getAgentSkill(agentId, skillData.name);
    if (existingSkill && !force) {
      const existingVersion = existingSkill.version || '0.0.0';
      const newVersion = skillData.version || '1.0.0';
      if (this._compareVersions(newVersion, existingVersion) <= 0) {
        return {
          success: false,
          error: `技能 "${skillData.name}" 已安装版本 ${existingVersion}，新版本 ${newVersion} 不高于现有版本。使用 force:true 强制覆盖。`,
          existingVersion,
          newVersion,
        };
      }
    }

    // 5. 构建完整技能对象
    const skillObject = {
      id: skillId,
      name: skillData.name,
      displayName: skillData.displayName || skillData.name,
      description: skillData.description || '',
      category: skillData.category || 'custom',
      triggerKeywords: skillData.triggerKeywords || [],
      instructions: skillData.instructions || '',
      systemPrompt: skillData.systemPrompt || skillData.instructions || '',
      toolsRequired: skillData.toolsRequired || [],
      dependencies: skillData.dependencies || [],
      version: skillData.version || '1.0.0',
      author: skillData.author || 'unknown',
      source: skillData.source || 'file',
      marketSkillId: skillData.marketSkillId || null,
      rawContent: skillData.content || '',
      metadata: skillData.metadata || {},
      // 时间戳
      installedAt: Date.now(),
      updatedAt: Date.now(),
      // 状态
      status: SKILL_INSTALL_STATUS.INSTALLED,
      enabled: true,
      // 使用统计
      useCount: 0,
      lastUsedAt: null,
      // 安全标记
      safetyChecked: !skipSafety,
      safetyWarnings: [],
    };

    // 6. 存储到子智能体的技能存储
    if (!this._skillStore.has(agentId)) {
      this._skillStore.set(agentId, new Map());
    }
    const agentSkills = this._skillStore.get(agentId);

    // 如果已存在同名技能，标记为更新
    if (existingSkill) {
      skillObject.status = SKILL_INSTALL_STATUS.UPDATED;
      skillObject.previousVersion = existingSkill.version;
      skillObject.installedAt = existingSkill.installedAt;
      skillObject.useCount = existingSkill.useCount || 0;
    }

    agentSkills.set(skillId, skillObject);

    // 7. 记录安装历史
    if (!this._installHistory.has(agentId)) {
      this._installHistory.set(agentId, []);
    }
    this._installHistory.get(agentId).push({
      skillId,
      name: skillData.name,
      version: skillData.version || '1.0.0',
      installedAt: Date.now(),
      status: skillObject.status,
    });

    // 8. 写入持久化
    this._persistAgentSkills(agentId);

    // 9. 同步到记忆引擎（技能记忆层 L4）
    if (this._memoryEngine) {
      try {
        this._memoryEngine.saveSkill({
          name: skillData.name,
          description: skillData.description || '',
          content: skillData.content || skillData.instructions || '',
          category: skillData.category || 'custom',
          trigger_keywords: skillData.triggerKeywords || [],
          auto_created: false,
        });
      } catch (e) {
        this._logger.warn(`[SkillInstaller] 同步到记忆引擎失败: ${e.message}`);
      }
    }

    this._logger.info(`[SkillInstaller] 技能安装成功: "${skillData.name}" v${skillData.version} → 子智能体 ${agentId}`);
    this.emit('skill_installed', { agentId, skillId, name: skillData.name, version: skillData.version });

    return {
      success: true,
      skillId,
      name: skillData.name,
      version: skillData.version,
      status: skillObject.status,
      validation: validation.status,
    };
  }

  /**
   * 卸载技能
   */
  uninstallSkill(agentId, skillId) {
    const agentSkills = this._skillStore.get(agentId);
    if (!agentSkills || !agentSkills.has(skillId)) {
      return { success: false, error: `技能不存在: ${skillId}` };
    }

    const skill = agentSkills.get(skillId);
    agentSkills.delete(skillId);
    skill.status = SKILL_INSTALL_STATUS.REMOVED;

    // 记录历史
    if (this._installHistory.has(agentId)) {
      this._installHistory.get(agentId).push({
        skillId,
        name: skill.name,
        version: skill.version,
        installedAt: Date.now(),
        status: SKILL_INSTALL_STATUS.REMOVED,
      });
    }

    this._persistAgentSkills(agentId);

    this._logger.info(`[SkillInstaller] 技能已卸载: "${skill.name}" (${skillId})`);
    this.emit('skill_uninstalled', { agentId, skillId, name: skill.name });

    return { success: true, skillId, name: skill.name };
  }

  /**
   * 启用/禁用技能
   */
  toggleSkill(agentId, skillId, enabled) {
    const skill = this._getAgentSkillById(agentId, skillId);
    if (!skill) {
      return { success: false, error: `技能不存在: ${skillId}` };
    }

    skill.enabled = enabled;
    skill.updatedAt = Date.now();
    this._persistAgentSkills(agentId);

    return { success: true, skillId, enabled };
  }

  /**
   * 记录技能使用
   */
  recordSkillUse(agentId, skillId) {
    const skill = this._getAgentSkillById(agentId, skillId);
    if (!skill) return;

    skill.useCount = (skill.useCount || 0) + 1;
    skill.lastUsedAt = Date.now();
    skill.updatedAt = Date.now();

    // 同步到记忆引擎
    if (this._memoryEngine) {
      try {
        this._memoryEngine.recordSkillUse(skillId);
      } catch (e) { /* 忽略 */ }
    }
  }

  // ═══════════════════════════════════════
  // 查询接口
  // ═══════════════════════════════════════

  /**
   * 获取子智能体的所有已安装技能
   */
  getAgentSkills(agentId) {
    const agentSkills = this._skillStore.get(agentId);
    if (!agentSkills) return [];

    return Array.from(agentSkills.values()).map(s => ({
      id: s.id,
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      category: s.category,
      version: s.version,
      author: s.author,
      status: s.status,
      enabled: s.enabled,
      useCount: s.useCount,
      lastUsedAt: s.lastUsedAt,
      installedAt: s.installedAt,
      triggerKeywords: s.triggerKeywords,
      toolsRequired: s.toolsRequired,
      source: s.source,
      marketSkillId: s.marketSkillId,
    }));
  }

  /**
   * 获取技能详情（含完整指令）
   */
  getAgentSkillDetail(agentId, skillId) {
    const skill = this._getAgentSkillById(agentId, skillId);
    if (!skill) return null;

    return {
      id: skill.id,
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      category: skill.category,
      version: skill.version,
      author: skill.author,
      instructions: skill.instructions,
      systemPrompt: skill.systemPrompt,
      triggerKeywords: skill.triggerKeywords,
      toolsRequired: skill.toolsRequired,
      dependencies: skill.dependencies,
      status: skill.status,
      enabled: skill.enabled,
      useCount: skill.useCount,
      lastUsedAt: skill.lastUsedAt,
      installedAt: skill.installedAt,
      updatedAt: skill.updatedAt,
      source: skill.source,
      marketSkillId: skill.marketSkillId,
      metadata: skill.metadata,
    };
  }

  /**
   * 获取子智能体技能统计
   */
  getAgentSkillStats(agentId) {
    const skills = this.getAgentSkills(agentId);
    const byCategory = {};
    let totalUseCount = 0;

    for (const s of skills) {
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
      totalUseCount += s.useCount || 0;
    }

    return {
      total: skills.length,
      enabled: skills.filter(s => s.enabled).length,
      disabled: skills.filter(s => !s.enabled).length,
      byCategory,
      totalUseCount,
      mostUsed: [...skills].sort((a, b) => (b.useCount || 0) - (a.useCount || 0)).slice(0, 5),
    };
  }

  /**
   * 获取安装历史
   */
  getInstallHistory(agentId, limit = 20) {
    const history = this._installHistory.get(agentId) || [];
    return history.slice(-limit).reverse();
  }

  /**
   * 按关键词搜索子智能体技能
   */
  searchAgentSkills(agentId, keyword) {
    const skills = this.getAgentSkills(agentId);
    if (!keyword) return skills;

    const kw = keyword.toLowerCase();
    return skills.filter(s =>
      s.name.toLowerCase().includes(kw) ||
      s.description.toLowerCase().includes(kw) ||
      s.category.toLowerCase().includes(kw) ||
      (s.triggerKeywords && s.triggerKeywords.some(tk => tk.toLowerCase().includes(kw)))
    );
  }

  /**
   * 获取子智能体技能的系统提示词（合并所有已启用技能）
   */
  getMergedSystemPrompt(agentId) {
    const skills = this.getAgentSkills(agentId).filter(s => s.enabled);
    if (skills.length === 0) return null;

    const parts = ['## 已安装技能\n'];

    for (const skill of skills) {
      parts.push(`### ${skill.name} (v${skill.version})`);
      parts.push(`类别: ${skill.category}`);
      if (skill.description) parts.push(`描述: ${skill.description}`);
      if (skill.triggerKeywords && skill.triggerKeywords.length > 0) {
        parts.push(`触发词: ${skill.triggerKeywords.join(', ')}`);
      }
      parts.push('');
    }

    parts.push('---');
    parts.push('请根据上下文自动判断应使用哪个技能来响应用户请求。');
    parts.push('当用户的请求匹配某个技能的触发词或描述时，请使用该技能的知识和指令来回答。');

    return parts.join('\n');
  }

  // ═══════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════

  _persistAgentSkills(agentId) {
    try {
      const agentDir = path.join(this._dataDir, agentId, 'skills');
      if (!fs.existsSync(agentDir)) {
        fs.mkdirSync(agentDir, { recursive: true });
      }

      const skills = this.getAgentSkills(agentId);
      const filePath = path.join(agentDir, 'installed_skills.json');
      fs.writeFileSync(filePath, JSON.stringify(skills, null, 2), 'utf8');

      // 同时持久化完整技能数据
      const agentSkills = this._skillStore.get(agentId);
      if (agentSkills) {
        const fullData = {};
        for (const [skillId, skill] of agentSkills) {
          fullData[skillId] = {
            ...skill,
            rawContent: undefined, // 不存储原始内容以节省空间（可通过市场重新获取）
          };
        }
        const fullPath = path.join(agentDir, 'skills_full.json');
        fs.writeFileSync(fullPath, JSON.stringify(fullData, null, 2), 'utf8');
      }
    } catch (e) {
      this._logger.warn(`[SkillInstaller] 技能持久化失败: ${e.message}`);
    }
  }

  /**
   * 恢复子智能体技能
   */
  restoreAgentSkills(agentId) {
    try {
      const agentDir = path.join(this._dataDir, agentId, 'skills');
      const fullPath = path.join(agentDir, 'skills_full.json');
      if (!fs.existsSync(fullPath)) return 0;

      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const agentSkills = new Map();

      for (const [skillId, skill] of Object.entries(data)) {
        agentSkills.set(skillId, skill);
      }

      this._skillStore.set(agentId, agentSkills);
      this._logger.info(`[SkillInstaller] 恢复子智能体 ${agentId} 的 ${agentSkills.size} 个技能`);
      return agentSkills.size;
    } catch (e) {
      this._logger.warn(`[SkillInstaller] 恢复技能失败 (${agentId}): ${e.message}`);
      return 0;
    }
  }

  // ═══════════════════════════════════════
  // 文件解析
  // ═══════════════════════════════════════

  /**
   * 解析 .skill / .skill.md / .md 文件
   */
  _parseSkillFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return this._parseSkillContent(content, path.basename(filePath));
    } catch (e) {
      this._logger.error(`[SkillInstaller] 文件读取失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 解析 SKILL.md 内容
   */
  _parseSkillContent(content, sourceFilename = '') {
    if (!content || content.trim().length === 0) return null;

    const skill = {
      content,
      source: sourceFilename || 'inline',
      triggerKeywords: [],
      toolsRequired: [],
      dependencies: [],
      metadata: {},
    };

    const lines = content.split('\n');

    // 解析标题 (# Skill Name)
    for (const line of lines) {
      const h1Match = line.match(/^#\s+(.+)/);
      if (h1Match && !skill.name) {
        skill.name = h1Match[1].trim();
        break;
      }
    }

    // 如果没找到标题，用文件名
    if (!skill.name && sourceFilename) {
      skill.name = sourceFilename.replace(/\.(skill|skill\.md|md)$/i, '');
    }
    if (!skill.name) {
      skill.name = `skill_${Date.now().toString(36)}`;
    }

    // 解析 one-liner (> description)
    for (const line of lines) {
      const oneLinerMatch = line.match(/^>\s*(.+)/);
      if (oneLinerMatch && !skill.description) {
        skill.description = oneLinerMatch[1].trim();
        break;
      }
    }

    // 分段解析
    let currentSection = '';
    let sectionContent = [];

    for (const line of lines) {
      const sectionMatch = line.match(/^##\s+(.+)/);
      if (sectionMatch) {
        // 处理上一段
        if (currentSection && sectionContent.length > 0) {
          this._processSection(skill, currentSection, sectionContent);
        }
        currentSection = sectionMatch[1].trim().toLowerCase();
        sectionContent = [];
        continue;
      }
      if (currentSection) {
        sectionContent.push(line);
      }
    }

    // 处理最后一段
    if (currentSection && sectionContent.length > 0) {
      this._processSection(skill, currentSection, sectionContent);
    }

    // 从内容中提取触发词（如果 section 中没有显式声明）
    if (skill.triggerKeywords.length === 0 && skill.description) {
      const descWords = skill.description.split(/[\s,，、]+/).filter(w => w.length >= 2);
      skill.triggerKeywords = descWords.slice(0, 5);
    }

    return skill;
  }

  _processSection(skill, section, lines) {
    const text = lines.join('\n').trim();

    switch (section) {
      case 'description':
      case '详细描述':
        if (!skill.description || skill.description.length < text.length) {
          skill.description = skill.description || '';
          if (text.length > skill.description.length) {
            skill.description = text;
          }
        }
        break;

      case 'category':
      case '分类':
        skill.category = text.split('\n')[0].trim().toLowerCase();
        break;

      case 'trigger keywords':
      case '触发词':
      case 'trigger_keywords':
        skill.triggerKeywords = lines
          .filter(l => l.trim().startsWith('-'))
          .map(l => l.replace(/^-\s*/, '').trim())
          .filter(Boolean);
        if (skill.triggerKeywords.length === 0) {
          skill.triggerKeywords = text.split(/[\n,，]+/).map(s => s.trim()).filter(Boolean);
        }
        break;

      case 'instructions':
      case '指令':
      case 'system prompt':
      case '系统提示词':
        skill.instructions = text;
        skill.systemPrompt = text;
        break;

      case 'tools required':
      case '所需工具':
        skill.toolsRequired = lines
          .filter(l => l.trim().startsWith('-'))
          .map(l => l.replace(/^-\s*/, '').trim())
          .filter(Boolean);
        break;

      case 'dependencies':
      case '依赖':
        skill.dependencies = lines
          .filter(l => l.trim().startsWith('-'))
          .map(l => {
            const dep = l.replace(/^-\s*/, '').trim();
            const [name, version] = dep.split(':').map(s => s.trim());
            return { name, version: version || '*' };
          });
        break;

      case 'version':
      case '版本':
        skill.version = text.split('\n')[0].trim();
        break;

      case 'author':
      case '作者':
        skill.author = text.split('\n')[0].trim();
        break;

      case 'metadata':
      case '元数据':
        try {
          skill.metadata = JSON.parse(text);
        } catch {
          // 解析为键值对
          const meta = {};
          for (const line of lines) {
            const [key, ...vals] = line.split(':');
            if (key && vals.length > 0) {
              meta[key.trim()] = vals.join(':').trim();
            }
          }
          skill.metadata = meta;
        }
        break;
    }
  }

  /**
   * 解压压缩包
   */
  async _extractArchive(filePath, format) {
    // 使用 Node.js 内置模块尝试解压
    // 简单实现：查找压缩包内的 .skill/.md 文件
    const extractDir = path.join(this._dataDir, 'temp_extract', crypto.randomUUID().slice(0, 8));

    try {
      if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true });
      }

      if (format === 'zip' || filePath.endsWith('.zip')) {
        await this._extractZip(filePath, extractDir);
      } else if (format === 'tar.gz' || filePath.endsWith('.tar.gz') || filePath.endsWith('.tgz')) {
        await this._extractTarGz(filePath, extractDir);
      }

      // 在解压目录中查找技能文件
      const skillFile = this._findSkillFile(extractDir);
      if (!skillFile) {
        // 清理
        this._rmdirSync(extractDir);
        return null;
      }

      const skillData = this._parseSkillFile(skillFile);
      // 清理
      this._rmdirSync(extractDir);

      return skillData;
    } catch (e) {
      // 清理
      try { this._rmdirSync(extractDir); } catch {}
      this._logger.error(`[SkillInstaller] 解压失败: ${e.message}`);
      throw e;
    }
  }

  async _extractZip(filePath, destDir) {
    try {
      // 尝试使用 Node.js 内置 zlib + 简单 ZIP 解析
      const AdmZip = (() => {
        try { return require('adm-zip'); } catch { return null; }
      })();

      if (AdmZip) {
        const zip = new AdmZip(filePath);
        zip.extractAllTo(destDir, true);
        return;
      }
    } catch {}

    // 回退：exec
    const { execSync } = require('child_process');
    try {
      execSync(`powershell -Command "Expand-Archive -Path '${filePath}' -DestinationPath '${destDir}' -Force"`, { stdio: 'ignore' });
    } catch {
      throw new Error('无法解压ZIP文件，请安装解压工具或将技能文件直接提供为.skill格式');
    }
  }

  async _extractTarGz(filePath, destDir) {
    const { execSync } = require('child_process');
    try {
      execSync(`tar -xzf "${filePath}" -C "${destDir}"`, { stdio: 'ignore' });
    } catch {
      throw new Error('无法解压tar.gz文件，请安装tar或将技能文件直接提供为.skill格式');
    }
  }

  _findSkillFile(dir) {
    const files = [];

    const walk = (d) => {
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            const lower = entry.name.toLowerCase();
            if (lower.endsWith('.skill') || lower === 'skill.md' || lower.endsWith('.skill.md')) {
              files.push(fullPath);
            }
          }
        }
      } catch {}
    };

    walk(dir);

    // 优先选择 .skill 文件
    const skillFile = files.find(f => f.toLowerCase().endsWith('.skill'));
    return skillFile || files[0] || null;
  }

  _rmdirSync(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 兼容旧版Node
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            this._rmdirSync(fullPath);
          } else {
            fs.unlinkSync(fullPath);
          }
        }
        fs.rmdirSync(dir);
      } catch {}
    }
  }

  // ═══════════════════════════════════════
  // 验证与安全
  // ═══════════════════════════════════════

  _validateSkillData(skill) {
    const issues = [];
    const warnings = [];

    // 必需字段
    if (!skill.name || skill.name.trim().length === 0) {
      issues.push('技能名称不能为空');
    }
    if (skill.name && skill.name.length > 100) {
      warnings.push('技能名称过长 (>100字符)');
    }

    // 内容检查
    const hasInstructions = skill.instructions && skill.instructions.trim().length > 0;
    const hasContent = skill.content && skill.content.trim().length > 0;
    if (!hasInstructions && !hasContent) {
      issues.push('技能内容不能为空（需要instructions或content）');
    }

    // 最低内容长度
    const effectiveContent = skill.instructions || skill.content || '';
    if (effectiveContent.length < 50) {
      warnings.push('技能内容过短 (<50字符)，可能不够实用');
    }

    // 分类检查
    if (skill.category && !SKILL_CATEGORIES.includes(skill.category.toLowerCase())) {
      warnings.push(`未知技能分类: ${skill.category}，将使用 "custom"`);
      skill.category = 'custom';
    }

    // 版本格式检查
    if (skill.version && !/^\d+\.\d+\.\d+/.test(skill.version)) {
      warnings.push(`版本格式不标准: ${skill.version}，建议使用 semver 格式 (如 1.0.0)`);
    }

    const status = issues.length > 0
      ? SKILL_PARSE_RESULT.INVALID
      : warnings.length > 0
        ? SKILL_PARSE_RESULT.WARNING
        : SKILL_PARSE_RESULT.VALID;

    return { status, issues, warnings };
  }

  _safetyCheck(skill) {
    const threats = [];
    const content = `${skill.name || ''} ${skill.description || ''} ${skill.instructions || ''} ${skill.content || ''}`;

    for (const { pattern, severity, desc } of DANGEROUS_PATTERNS) {
      if (pattern.test(content)) {
        threats.push({ pattern: pattern.source, severity, desc, matched: content.match(pattern)?.[0]?.substring(0, 50) });
      }
    }

    return {
      safe: threats.length === 0,
      threats,
      threatCount: threats.length,
      criticalCount: threats.filter(t => t.severity === 'critical').length,
      highCount: threats.filter(t => t.severity === 'high').length,
    };
  }

  // ═══════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════

  _getAgentSkill(agentId, skillName) {
    const agentSkills = this._skillStore.get(agentId);
    if (!agentSkills) return null;

    for (const skill of agentSkills.values()) {
      if (skill.name.toLowerCase() === skillName.toLowerCase()) {
        return skill;
      }
    }
    return null;
  }

  _getAgentSkillById(agentId, skillId) {
    const agentSkills = this._skillStore.get(agentId);
    if (!agentSkills) return null;
    return agentSkills.get(skillId) || null;
  }

  _compareVersions(v1, v2) {
    const parts1 = (v1 || '0.0.0').split('.').map(Number);
    const parts2 = (v2 || '0.0.0').split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const a = parts1[i] || 0;
      const b = parts2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }

  /**
   * 设置记忆引擎引用
   */
  setMemoryEngine(memoryEngine) {
    this._memoryEngine = memoryEngine;
  }

  /**
   * 设置安全守护引用
   */
  setGuardian(guardian) {
    this._guardian = guardian;
  }

  /**
   * 清理资源
   */
  close() {
    // 持久化所有数据
    for (const agentId of this._skillStore.keys()) {
      this._persistAgentSkills(agentId);
    }
    this._skillStore.clear();
    this._installHistory.clear();
    this.removeAllListeners();
  }
}

module.exports = {
  SubAgentSkillInstaller,
  SKILL_INSTALL_STATUS,
  SKILL_PARSE_RESULT,
  SKILL_CATEGORIES,
};
