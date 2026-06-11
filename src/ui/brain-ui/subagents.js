/**
 * 蜜糖 TriCore Agent — 子智能体管理中心
 * v3.0.0 — 全流程全交互逻辑
 */

'use strict';

const API = window.triCoreAPI;
const $ = (id) => document.getElementById(id);

// ═══════════════════════════════════════
// 全局状态
// ═══════════════════════════════════════

const STATE = {
  currentView: 'dashboard',
  listLayout: 'grid',
  agents: [],
  teams: [],
  skills: [],
  selectedAgentId: null,
  wizardStep: 1,
  monitorPaused: false,
  messageStreamPaused: false,
  startTime: Date.now(),
  refreshTimer: null,
  streamTimer: null,
  monitorTimer: null,
  skillTab: 'installed',
  monitorTab: 'live',
  installMethod: 'market',

  // 聊天状态
  chat: {
    activeAgentId: null,
    activeAgentName: null,
    activeSessionId: null,
    sessions: [],
    messages: [],
  },
};

// ═══════════════════════════════════════
// 初始化
// ═══════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await initSettings();
  await refreshAll();
  STATE.refreshTimer = setInterval(refreshAll, 5000);
  STATE.streamTimer = setInterval(refreshMessageStream, 3000);
  STATE.monitorTimer = setInterval(refreshMonitorView, 2000);
  setInterval(updateUptime, 1000);
  startDemoMessageStream();
  console.log('[子智能体管理中心] 初始化完成');
});

async function initSettings() {
  try {
    if (window.TriCoreSettings) {
      await window.TriCoreSettings.load();
    }
  } catch (e) { console.warn('设置初始化失败:', e.message); }

  const btnSettings = $('btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => {
      if (window.TriCoreSettingsPanel) {
        window.TriCoreSettingsPanel.toggle();
      }
    });
  }
}

// ═══════════════════════════════════════
// 事件绑定
// ═══════════════════════════════════════

function bindEvents() {
  // 技能安装对话框事件
  const btnInstallSkill = $('btn-install-skill');
  if (btnInstallSkill) btnInstallSkill.addEventListener('click', openSkillInstaller);

  // 技能安装方法切换
  document.querySelectorAll('.install-method-btn').forEach(btn => {
    btn.addEventListener('click', () => switchInstallMethod(btn.dataset.method));
  });

  // 技能文件选择
  const fileInput = $('skill-file-input');
  if (fileInput) fileInput.addEventListener('change', handleSkillFileSelect);

  // 模态框点击遮罩关闭
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (overlay.id === 'create-agent-modal') closeCreateAgentWizard();
        else if (overlay.id === 'agent-detail-modal') closeAgentDetail();
        else if (overlay.id === 'agent-chat-modal') closeAgentChat();
        else if (overlay.id === 'team-create-modal') closeTeamCreator();
        else if (overlay.id === 'skill-install-modal') closeSkillInstaller();
        else if (overlay.id === 'confirm-modal') closeConfirmModal();
      }
    });
  });

  // 确认对话框
  const btnConfirmCancel = $('btn-confirm-cancel');
  const btnConfirmOk = $('btn-confirm-ok');
  if (btnConfirmCancel) btnConfirmCancel.addEventListener('click', closeConfirmModal);

  // 全局键盘快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCreateAgentWizard();
      closeAgentDetail();
      closeAgentChat();
      closeTeamCreator();
      closeSkillInstaller();
      closeConfirmModal();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      if (window.TriCoreSettingsPanel) window.TriCoreSettingsPanel.toggle();
    }
  });
}

// ═══════════════════════════════════════
// 视图切换
// ═══════════════════════════════════════

function switchView(view) {
  STATE.currentView = view;

  // 更新导航高亮
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === view);
  });

  // 切换视图面板
  document.querySelectorAll('.view-panel').forEach(panel => panel.classList.remove('active'));
  const viewPanel = document.getElementById(`view-${view}`);
  if (viewPanel) viewPanel.classList.add('active');

  // 按需刷新
  switch (view) {
    case 'dashboard': refreshDashboard(); break;
    case 'list': refreshAgentList(); break;
    case 'teams': refreshTeams(); break;
    case 'skills': refreshSkillView(); break;
    case 'monitor': refreshMonitorView(); break;
    case 'security': refreshSecurityView(); break;
  }
}

// ═══════════════════════════════════════
// 数据刷新
// ═══════════════════════════════════════

async function refreshAll() {
  await Promise.all([
    refreshAgentsData(),
    refreshTeamsData(),
    refreshSkillsData(),
  ]);
  updateSidebarStats();
  updateFooter();
  if (STATE.currentView === 'dashboard') refreshDashboard();
}

async function refreshAgentsData() {
  try {
    if (API?.getSubAgents) {
      const result = await API.getSubAgents();
      STATE.agents = result?.agents || [];
    } else {
      // 演示数据
      if (STATE.agents.length === 0) {
        STATE.agents = generateDemoAgents();
      }
    }
  } catch (e) {
    console.error('刷新智能体数据失败:', e);
    if (STATE.agents.length === 0) STATE.agents = generateDemoAgents();
  }
}

async function refreshTeamsData() {
  try {
    if (API?.getTeams) {
      const result = await API.getTeams();
      STATE.teams = result?.teams || [];
    } else {
      if (STATE.teams.length === 0) STATE.teams = generateDemoTeams();
    }
  } catch (e) {
    if (STATE.teams.length === 0) STATE.teams = generateDemoTeams();
  }
}

async function refreshSkillsData() {
  try {
    if (API?.getAllSkills) {
      const result = await API.getAllSkills();
      STATE.skills = result?.skills || [];
    } else {
      if (STATE.skills.length === 0) STATE.skills = generateDemoSkills();
    }
  } catch (e) {
    if (STATE.skills.length === 0) STATE.skills = generateDemoSkills();
  }
}

function updateSidebarStats() {
  const activeCount = STATE.agents.filter(a => a.status === 'running').length;
  const totalAgents = STATE.agents.length;
  const totalTeams = STATE.teams.length;
  const totalSkills = STATE.skills.length;

  setText('sidebar-active', activeCount);
  setText('sidebar-total', totalAgents);
  setText('sidebar-teams', totalTeams);
  setText('sidebar-skills', totalSkills);

  // 顶部指示器
  const indicator = $('ind-agents');
  if (indicator) {
    indicator.className = `indicator ${activeCount > 0 ? 'active' : ''}`;
    indicator.querySelector('.label').textContent = activeCount > 0 ? `${activeCount}活跃` : '就绪';
  }
}

function updateFooter() {
  const activeCount = STATE.agents.filter(a => a.status === 'running').length;
  setText('footer-agents', `智能体: ${activeCount}/${STATE.agents.length}`);
  setText('footer-status', activeCount > 0 ? '● 运行中' : '● 就绪');
}

function updateUptime() {
  const sec = Math.round((Date.now() - STATE.startTime) / 1000);
  const min = Math.floor(sec / 60);
  const h = Math.floor(min / 60);
  setText('footer-uptime', h > 0 ? `运行: ${h}h${min % 60}m` : min > 0 ? `运行: ${min}m${sec % 60}s` : `运行: ${sec}s`);
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

// ═══════════════════════════════════════
// 仪表盘
// ═══════════════════════════════════════

function refreshDashboard() {
  const agents = STATE.agents;
  const activeAgents = agents.filter(a => a.status === 'running');
  const totalAgents = agents.length;

  // 统计卡片
  setText('dash-total-agents', totalAgents);
  setText('dash-active-agents', activeAgents.length);
  setText('dash-total-teams', STATE.teams.length);
  setText('dash-total-skills', STATE.skills.length);
  setText('dash-total-msgs', Math.floor(Math.random() * 200 + 50));
  setText('dash-uptime', Math.floor((Date.now() - STATE.startTime) / 3600000) + 'h');

  setText('dash-active-pct', totalAgents > 0 ? Math.round(activeAgents.length / totalAgents * 100) + '%' : '0%');
  setText('dash-skills-active', STATE.skills.filter(s => s.enabled).length + ' 已启用');
  setText('dash-errors', STATE.agents.filter(a => a.status === 'error').length + ' 错误');

  // 活跃智能体列表
  renderDashboardActiveList(activeAgents);

  // 资源使用率
  const cpuUsage = Math.floor(Math.random() * 40 + 10);
  const memUsage = Math.floor(Math.random() * 30 + 20);
  const tokenUsed = Math.floor(Math.random() * 50000 + 10000);
  const tokenTotal = 100000;
  const slotUsed = activeAgents.length;
  const slotTotal = Math.max(10, totalAgents * 2);

  setText('res-cpu-val', cpuUsage + '%');
  setText('res-mem-val', memUsage + '%');
  setText('res-token-val', (tokenUsed / 1000).toFixed(0) + 'K/' + (tokenTotal / 1000).toFixed(0) + 'K');
  setText('res-slot-val', slotUsed + '/' + slotTotal);

  animateBar('res-cpu-fill', cpuUsage);
  animateBar('res-mem-fill', memUsage);
  animateBar('res-token-fill', (tokenUsed / tokenTotal * 100));
  animateBar('res-slot-fill', (slotUsed / slotTotal * 100));

  // 类型分布
  const typeCounts = { assistant: 0, analyst: 0, executor: 0, monitor: 0, custom: 0 };
  agents.forEach(a => { if (typeCounts[a.type] !== undefined) typeCounts[a.type]++; });

  setText('type-assistant', typeCounts.assistant);
  setText('type-analyst', typeCounts.analyst);
  setText('type-executor', typeCounts.executor);
  setText('type-monitor', typeCounts.monitor);
  setText('type-custom', typeCounts.custom);

  const maxType = Math.max(1, ...Object.values(typeCounts));
  Object.entries(typeCounts).forEach(([type, count]) => {
    animateBar(`tb-fill type-${type}`, (count / maxType * 100), true);
  });
}

function renderDashboardActiveList(activeAgents) {
  const container = $('dash-active-list');
  if (!container) return;

  if (activeAgents.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无活跃子智能体</div>';
    return;
  }

  const typeIcons = { assistant: '🔧', analyst: '📊', executor: '⚡', monitor: '🛡', custom: '🎨' };
  const statusLabels = { running: '运行中', stopped: '已停止', error: '异常', pending: '等待中' };

  container.innerHTML = activeAgents.slice(0, 5).map(a => `
    <div class="mini-agent-item" onclick="openAgentDetail('${a.id}')">
      <div class="mini-agent-avatar avatar-${a.type || 'assistant'}">${typeIcons[a.type] || '🤖'}</div>
      <div class="mini-agent-info">
        <div class="mini-agent-name">${escapeHtml(a.name || '未命名')}</div>
        <div class="mini-agent-meta">${escapeHtml(a.type || '通用')} · ${a.sessionCount || 0} 会话</div>
      </div>
      <span class="mini-agent-status status-badge-${a.status || 'pending'}">${statusLabels[a.status] || a.status}</span>
    </div>
  `).join('');
}

function animateBar(selector, targetPercent, isClass = false) {
  if (isClass) {
    const el = document.querySelector(`.${selector.split(' ').join('.')}`);
    if (el) el.style.width = targetPercent + '%';
  } else {
    const el = $(selector);
    if (el) el.style.width = targetPercent + '%';
  }
}

// ═══════════════════════════════════════
// 消息流演示
// ═══════════════════════════════════════

let demoMessages = [];

function startDemoMessageStream() {
  const events = [
    { agent: '数据分析助手', content: '已完成 sales_report.csv 的分析，发现Q3增长率达12.5%' },
    { agent: '代码审查员', content: '审查了 PR #234，发现2个潜在性能问题' },
    { agent: '文档撰写员', content: '已生成 API 文档 v2.3.0 的更新版本' },
    { agent: '监控守护', content: '检测到 CPU 使用率峰值 87%，已自动扩容' },
    { agent: '翻译助手', content: '完成中英文技术文档翻译，共3200字' },
    { agent: '数据分析助手', content: '用户画像分析完成，新增3个用户分群' },
    { agent: '任务执行器', content: '批量文件处理任务完成：120/120 文件已处理' },
    { agent: '代码审查员', content: '发现安全漏洞 CVE-2024-xxxx，已通知修复' },
  ];
  demoMessages = [...events];
}

async function refreshMessageStream() {
  if (STATE.messageStreamPaused) return;
  const container = $('dash-message-stream');
  if (!container || STATE.currentView !== 'dashboard') return;

  // 随机添加一条新消息
  if (demoMessages.length > 0 && Math.random() > 0.5) {
    const msg = demoMessages[Math.floor(Math.random() * demoMessages.length)];
    const entry = document.createElement('div');
    entry.className = 'stream-item';
    const now = new Date().toLocaleTimeString();
    entry.innerHTML = `
      <div class="stream-agent">🤖 ${msg.agent}</div>
      <div class="stream-content">${msg.content}</div>
      <div class="stream-time">${now}</div>
    `;
    container.insertBefore(entry, container.firstChild);

    // 限制最多50条
    while (container.children.length > 50) {
      container.removeChild(container.lastChild);
    }

    // 移除空状态
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
  }
}

function toggleMessageStream() {
  STATE.messageStreamPaused = !STATE.messageStreamPaused;
  const btn = $('btn-pause-stream');
  if (btn) {
    btn.textContent = STATE.messageStreamPaused ? '▶ 恢复' : '⏸ 暂停';
  }
}

// ═══════════════════════════════════════
// 智能体列表
// ═══════════════════════════════════════

function setListLayout(layout) {
  STATE.listLayout = layout;
  document.querySelectorAll('.view-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === layout);
  });
  const grid = $('agent-grid');
  const table = $('agent-table-container');
  if (grid) grid.style.display = layout === 'grid' ? 'grid' : 'none';
  if (table) table.style.display = layout === 'table' ? 'block' : 'none';
  filterAgentList();
}

function filterAgentList() {
  const searchTerm = ($('agent-search')?.value || '').toLowerCase();
  const statusFilter = $('filter-status')?.value || 'all';
  const typeFilter = $('filter-type')?.value || 'all';
  const safetyFilter = $('filter-safety')?.value || 'all';

  let filtered = STATE.agents.filter(a => {
    if (searchTerm && !(a.name || '').toLowerCase().includes(searchTerm) &&
        !(a.type || '').toLowerCase().includes(searchTerm) &&
        !(a.description || '').toLowerCase().includes(searchTerm)) return false;
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    if (typeFilter !== 'all' && a.type !== typeFilter) return false;
    if (safetyFilter !== 'all' && a.safetyLevel !== safetyFilter) return false;
    return true;
  });

  if (STATE.listLayout === 'grid') {
    renderAgentGrid(filtered);
  } else {
    renderAgentTable(filtered);
  }

  setText('page-info', `显示 ${filtered.length}/${STATE.agents.length}`);
}

function refreshAgentList() {
  refreshAgentsData().then(() => filterAgentList());
}

function renderAgentGrid(agents) {
  const container = $('agent-grid');
  if (!container) return;

  if (agents.length === 0) {
    container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">没有匹配的子智能体</div>';
    return;
  }

  const typeIcons = { assistant: '🔧', analyst: '📊', executor: '⚡', monitor: '🛡', custom: '🎨' };
  const typeNames = { assistant: '通用助手', analyst: '数据分析', executor: '任务执行', monitor: '监控守护', custom: '自定义' };
  const statusLabels = { running: '运行中', stopped: '已停止', error: '异常', pending: '等待中' };
  const safetyLabels = { low: '低', medium: '中', high: '高', maximum: '最高' };

  container.innerHTML = agents.map(a => `
    <div class="agent-card status-${a.status || 'pending'}" onclick="openAgentDetail('${a.id}')">
      <div class="agent-card-header">
        <div class="agent-card-identity">
          <div class="agent-card-avatar avatar-${a.type || 'assistant'}">${typeIcons[a.type] || '🤖'}</div>
          <div>
            <div class="agent-card-name">${escapeHtml(a.name || '未命名')}</div>
            <div class="agent-card-type">${typeNames[a.type] || a.type || '通用'}</div>
          </div>
        </div>
        <span class="agent-card-status-badge status-badge-${a.status || 'pending'}">${statusLabels[a.status] || a.status}</span>
      </div>
      <div class="agent-card-body">
        <div class="agent-card-desc">${escapeHtml(a.description || '暂无描述')}</div>
        <div class="agent-card-meta">
          <span>🔒 ${safetyLabels[a.safetyLevel] || a.safetyLevel}</span>
          <span>💬 ${a.sessionCount || 0} 会话</span>
          <span>📅 ${a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '-'}</span>
        </div>
      </div>
      <div class="agent-card-footer" onclick="event.stopPropagation()">
        ${a.status === 'running'
          ? `<button class="btn-mini btn-chat" onclick="openAgentChatWindow('${a.id}','${escapeAttr(a.name)}')">💬 对话</button>
             <button class="btn-mini" onclick="toggleAgent('${a.id}','stop')">⏹ 停止</button>
             <button class="btn-mini" onclick="openAgentDetail('${a.id}')">📋 详情</button>`
          : a.status === 'stopped'
            ? `<button class="btn-mini" onclick="toggleAgent('${a.id}','start')">▶ 启动</button>
               <button class="btn-mini" onclick="openAgentDetail('${a.id}')">📋 详情</button>
               <button class="btn-mini btn-danger" onclick="deleteAgent('${a.id}')">🗑</button>`
            : `<button class="btn-mini" onclick="openAgentDetail('${a.id}')">📋 详情</button>
               <button class="btn-mini btn-danger" onclick="deleteAgent('${a.id}')">🗑</button>`}
      </div>
    </div>
  `).join('');
}

function renderAgentTable(agents) {
  const tbody = $('agent-table-body');
  if (!tbody) return;

  if (agents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-row">没有匹配的子智能体</td></tr>';
    return;
  }

  const typeNames = { assistant: '通用助手', analyst: '数据分析', executor: '任务执行', monitor: '监控守护', custom: '自定义' };
  const statusLabels = { running: '运行中', stopped: '已停止', error: '异常', pending: '等待中' };
  const statusBadges = { running: 'status-badge-running', stopped: 'status-badge-stopped', error: 'status-badge-error', pending: 'status-badge-pending' };

  tbody.innerHTML = agents.map(a => `
    <tr onclick="openAgentDetail('${a.id}')" style="cursor:pointer;">
      <td class="table-name">🤖 ${escapeHtml(a.name || '未命名')}</td>
      <td>${typeNames[a.type] || a.type || '通用'}</td>
      <td><span class="agent-card-status-badge ${statusBadges[a.status] || 'status-badge-stopped'}">${statusLabels[a.status] || a.status}</span></td>
      <td>🔒 ${a.safetyLevel || 'medium'}</td>
      <td>${a.quota || 'medium'}</td>
      <td>${a.sessionCount || 0}</td>
      <td>${a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '-'}</td>
      <td class="table-actions" onclick="event.stopPropagation()">
        ${a.status === 'running'
          ? `<button class="btn-mini btn-chat" onclick="openAgentChatWindow('${a.id}','${escapeAttr(a.name)}')">💬</button>
             <button class="btn-mini" onclick="toggleAgent('${a.id}','stop')">⏹</button>`
          : a.status === 'stopped'
            ? `<button class="btn-mini" onclick="toggleAgent('${a.id}','start')">▶</button>`
            : ''}
        <button class="btn-mini btn-danger" onclick="deleteAgent('${a.id}')">🗑</button>
      </td>
    </tr>
  `).join('');
}

// ═══════════════════════════════════════
// 创建智能体向导
// ═══════════════════════════════════════

function openCreateAgentWizard() {
  STATE.wizardStep = 1;
  const modal = $('create-agent-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  resetWizardForm();
  updateWizardUI();
}

function closeCreateAgentWizard() {
  const modal = $('create-agent-modal');
  if (modal) modal.style.display = 'none';
  resetWizardForm();
}

function resetWizardForm() {
  $('wiz-name').value = '';
  $('wiz-type').value = 'assistant';
  $('wiz-model').value = 'auto';
  $('wiz-description').value = '';
  $('wiz-system-prompt').value = '';
  $('wiz-reasoning').value = 'chain-of-thought';
  $('wiz-security').value = 'medium';
  $('wiz-quota').value = 'medium';
  $('wiz-concurrency').value = 3;
  $('wiz-concurrency-val').textContent = '3';
  $('wiz-token-budget').value = 10000;
  $('wiz-token-val').textContent = '10K';
  $('wiz-auto-start').checked = true;
  $('wiz-audit-log').checked = true;

  document.querySelectorAll('#wiz-tools input[type="checkbox"]').forEach(cb => {
    cb.checked = ['web_search', 'file_io', 'memory_rw', 'data_analysis', 'rag_query'].includes(cb.value);
  });
  document.querySelectorAll('#wiz-preset-skills input[type="checkbox"]').forEach(cb => {
    cb.checked = cb.value === 'basic_chat';
  });
}

function wizardNext() {
  if (STATE.wizardStep < 4) {
    // 验证当前步骤
    if (STATE.wizardStep === 1) {
      const name = $('wiz-name').value.trim();
      if (!name) { showToast('请输入子智能体名称', 'warning'); return; }
    }
    STATE.wizardStep++;
    if (STATE.wizardStep === 4) {
      renderWizardSummary();
    }
    updateWizardUI();
  }
}

function wizardPrev() {
  if (STATE.wizardStep > 1) {
    STATE.wizardStep--;
    updateWizardUI();
  }
}

function updateWizardUI() {
  // 步骤指示器
  document.querySelectorAll('.wizard-step').forEach((step, idx) => {
    const stepNum = idx + 1;
    step.classList.remove('active', 'completed');
    if (stepNum === STATE.wizardStep) step.classList.add('active');
    else if (stepNum < STATE.wizardStep) step.classList.add('completed');
  });

  // 页面切换
  document.querySelectorAll('.wizard-page').forEach(p => p.classList.remove('active'));
  const page = $(`wizard-page-${STATE.wizardStep}`);
  if (page) page.classList.add('active');

  // 按钮
  const btnPrev = $('wiz-btn-prev');
  const btnNext = $('wiz-btn-next');
  const btnCreate = $('wiz-btn-create');

  if (btnPrev) btnPrev.style.display = STATE.wizardStep > 1 ? 'inline-flex' : 'none';
  if (btnNext) btnNext.style.display = STATE.wizardStep < 4 ? 'inline-flex' : 'none';
  if (btnCreate) btnCreate.style.display = STATE.wizardStep === 4 ? 'inline-flex' : 'none';
}

function renderWizardSummary() {
  const container = $('confirm-summary-content');
  if (!container) return;

  const typeNames = { assistant: '🔧 通用助手', analyst: '📊 数据分析', executor: '⚡ 任务执行', monitor: '🛡 监控守护', custom: '🎨 自定义' };
  const modelNames = { auto: '🤖 自动选择', 'gpt-4o': 'GPT-4o', 'claude-3.5': 'Claude 3.5 Sonnet', 'deepseek-v3': 'DeepSeek V3', 'qwen-max': 'Qwen Max', 'glm-4': 'GLM-4' };
  const securityNames = { low: '🟢 低', medium: '🟡 中', high: '🟠 高', maximum: '🔴 最高' };
  const quotaNames = { minimal: '最小(10%)', low: '低(25%)', medium: '中(50%)', high: '高(75%)' };
  const reasoningNames = { direct: '⚡ 直接响应', 'chain-of-thought': '🔗 思维链', 'tree-of-thought': '🌳 思维树', reflexion: '🔄 反思模式' };

  const selectedTools = Array.from(document.querySelectorAll('#wiz-tools input:checked')).map(cb => cb.value);
  const selectedSkills = Array.from(document.querySelectorAll('#wiz-preset-skills input:checked')).map(cb => cb.value);

  const toolNames = { web_search: '🌐 网络搜索', file_io: '📁 文件读写', code_exec: '💻 代码执行', browser: '🌍 浏览器控制', memory_rw: '🧠 记忆读写', api_call: '🔌 API调用', image_gen: '🎨 图像生成', data_analysis: '📊 数据分析', shell_exec: '⚙ Shell执行', rag_query: '📚 RAG检索' };
  const skillNames = { basic_chat: '💬 基础对话', code_review: '🔍 代码审查', doc_writer: '📝 文档撰写', data_viz: '📈 数据可视化', translator: '🌍 多语言翻译', debugger: '🐛 调试助手' };

  container.innerHTML = `
    <div class="confirm-item"><div class="ci-label">名称</div><div class="ci-value">${escapeHtml($('wiz-name').value || '-')}</div></div>
    <div class="confirm-item"><div class="ci-label">类型</div><div class="ci-value">${typeNames[$('wiz-type').value]}</div></div>
    <div class="confirm-item"><div class="ci-label">基础模型</div><div class="ci-value">${modelNames[$('wiz-model').value]}</div></div>
    <div class="confirm-item"><div class="ci-label">推理模式</div><div class="ci-value">${reasoningNames[$('wiz-reasoning').value]}</div></div>
    <div class="confirm-item"><div class="ci-label">安全等级</div><div class="ci-value">${securityNames[$('wiz-security').value]}</div></div>
    <div class="confirm-item"><div class="ci-label">资源配额</div><div class="ci-value">${quotaNames[$('wiz-quota').value]}</div></div>
    <div class="confirm-item"><div class="ci-label">并发请求</div><div class="ci-value">${$('wiz-concurrency').value}</div></div>
    <div class="confirm-item"><div class="ci-label">Token预算</div><div class="ci-value">${($('wiz-token-budget').value / 1000).toFixed(0)}K</div></div>
    <div class="confirm-item full"><div class="ci-label">可用工具</div><div class="ci-value">${selectedTools.map(t => toolNames[t] || t).join(', ') || '无'}</div></div>
    <div class="confirm-item full"><div class="ci-label">预设技能</div><div class="ci-value">${selectedSkills.map(s => skillNames[s] || s).join(', ') || '无'}</div></div>
    <div class="confirm-item full"><div class="ci-label">自动启动</div><div class="ci-value">${$('wiz-auto-start').checked ? '✅ 是' : '❌ 否'}</div></div>
  `;
}

async function confirmCreateAgent() {
  const name = $('wiz-name').value.trim();
  const type = $('wiz-type').value;
  const description = $('wiz-description').value.trim();
  const security = $('wiz-security').value;
  const quota = $('wiz-quota').value;
  const autoStart = $('wiz-auto-start').checked;
  const model = $('wiz-model').value;
  const reasoning = $('wiz-reasoning').value;
  const systemPrompt = $('wiz-system-prompt').value.trim();
  const concurrency = parseInt($('wiz-concurrency').value);
  const tokenBudget = parseInt($('wiz-token-budget').value);

  if (!name) { showToast('请输入子智能体名称', 'warning'); return; }

  try {
    if (API?.createSubAgent) {
      const result = await API.createSubAgent({
        name, type, description, security, quota, autoStart,
        model, reasoning, systemPrompt, concurrency, tokenBudget,
      });
      if (result?.success) {
        showToast(`子智能体 "${name}" 创建成功！`, 'success');
        closeCreateAgentWizard();
        await refreshAll();
      } else {
        showToast(`创建失败: ${result?.error || '未知错误'}`, 'error');
      }
    } else {
      // 演示模式：模拟创建
      const newAgent = {
        id: 'agent_' + Date.now(),
        name, type, description, status: autoStart ? 'running' : 'stopped',
        safetyLevel: security, quota,
        createdAt: new Date().toISOString(),
        sessionCount: 0,
        model, reasoning, systemPrompt,
      };
      STATE.agents.unshift(newAgent);
      showToast(`子智能体 "${name}" 创建成功！（演示模式）`, 'success');
      closeCreateAgentWizard();
      await refreshAll();
      if (STATE.currentView === 'list') filterAgentList();
      else switchView('list');
    }
  } catch (e) {
    showToast(`创建失败: ${e.message}`, 'error');
  }
}

// ═══════════════════════════════════════
// 智能体详情
// ═══════════════════════════════════════

async function openAgentDetail(agentId) {
  const agent = STATE.agents.find(a => a.id === agentId);
  if (!agent) return;

  STATE.selectedAgentId = agentId;
  const modal = $('agent-detail-modal');
  if (!modal) return;

  setText('agent-detail-title', `🤖 ${agent.name || agentId}`);

  // 更新按钮
  const btnToggle = $('btn-detail-toggle');
  if (btnToggle) {
    const isRunning = agent.status === 'running';
    btnToggle.textContent = isRunning ? '⏹ 停止' : '▶ 启动';
    btnToggle.onclick = () => toggleAgentFromDetail();
  }

  modal.style.display = 'flex';
  switchDetailTab('overview');
}

function closeAgentDetail() {
  const modal = $('agent-detail-modal');
  if (modal) modal.style.display = 'none';
  STATE.selectedAgentId = null;
}

function switchDetailTab(tab) {
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.remove('active'));
  const content = $(`detail-tab-${tab}`);
  if (content) content.classList.add('active');

  const agent = STATE.agents.find(a => a.id === STATE.selectedAgentId);
  if (!agent) return;

  switch (tab) {
    case 'overview': renderDetailOverview(agent, content); break;
    case 'sessions': renderDetailSessions(agent, content); break;
    case 'skills': renderDetailSkills(agent, content); break;
    case 'logs': renderDetailLogs(agent, content); break;
    case 'security': renderDetailSecurity(agent, content); break;
  }
}

function renderDetailOverview(agent, container) {
  const typeNames = { assistant: '通用助手', analyst: '数据分析', executor: '任务执行', monitor: '监控守护', custom: '自定义' };
  const statusLabels = { running: '运行中', stopped: '已停止', error: '异常', pending: '等待中' };
  const reasoningNames = { direct: '直接响应', 'chain-of-thought': '思维链', 'tree-of-thought': '思维树', reflexion: '反思模式' };

  container.innerHTML = `
    <div class="detail-grid">
      <div class="detail-item">
        <span class="detail-label">ID</span>
        <span class="detail-value">${escapeHtml(agent.id)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">类型</span>
        <span class="detail-value">${typeNames[agent.type] || agent.type}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">状态</span>
        <span class="detail-value status-${agent.status}">${statusLabels[agent.status] || agent.status}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">安全等级</span>
        <span class="detail-value">🔒 ${agent.safetyLevel || 'medium'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">资源配额</span>
        <span class="detail-value">${agent.quota || 'medium'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">基础模型</span>
        <span class="detail-value">${agent.model || 'auto'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">推理模式</span>
        <span class="detail-value">${reasoningNames[agent.reasoning] || agent.reasoning || 'chain-of-thought'}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">创建时间</span>
        <span class="detail-value">${agent.createdAt ? new Date(agent.createdAt).toLocaleString() : '-'}</span>
      </div>
      <div class="detail-item full-width">
        <span class="detail-label">描述</span>
        <span class="detail-value">${escapeHtml(agent.description || '无描述')}</span>
      </div>
      <div class="detail-item full-width">
        <span class="detail-label">系统提示词</span>
        <span class="detail-value" style="font-size:11px;white-space:pre-wrap;">${escapeHtml(agent.systemPrompt || '未设置')}</span>
      </div>
      <div class="detail-item full-width">
        <span class="detail-label">运行统计</span>
        <div class="safety-report">
          <div class="safety-stat"><span>会话数</span><span>${agent.sessionCount || 0}</span></div>
          <div class="safety-stat"><span>已处理消息</span><span>${agent.messageCount || 0}</span></div>
          <div class="safety-stat"><span>技能数</span><span>${agent.skillCount || 0}</span></div>
          <div class="safety-stat"><span>最后活跃</span><span>${agent.lastActive ? new Date(agent.lastActive).toLocaleString() : '-'}</span></div>
        </div>
      </div>
    </div>
  `;
}

function renderDetailSessions(agent, container) {
  const sessions = agent.sessions || [];
  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无会话记录</div>';
    return;
  }
  container.innerHTML = sessions.map(s => `
    <div class="session-item" onclick="openAgentChatWindow('${agent.id}','${escapeAttr(agent.name)}')">
      <div class="session-item-name">${escapeHtml(s.name || '未命名会话')}</div>
      <div class="session-item-meta">
        <span>${s.messageCount || 0} 条消息</span>
        <span>${s.createdAt ? new Date(s.createdAt).toLocaleDateString() : ''}</span>
      </div>
    </div>
  `).join('');
}

function renderDetailSkills(agent, container) {
  const skills = agent.skills || STATE.skills.filter(s => s.agentId === agent.id);
  if (skills.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无已安装技能</div>';
    return;
  }
  container.innerHTML = skills.map(s => `
    <div class="skill-card">
      <div class="skill-card-info">
        <div class="skill-card-name">${escapeHtml(s.name || '未命名')}</div>
        <div class="skill-card-desc">${escapeHtml(s.description || '无描述')}</div>
        <div class="skill-card-meta">
          <span class="skill-badge category">${s.category || '通用'}</span>
          <span class="skill-badge version">v${s.version || '1.0'}</span>
          <span class="skill-badge ${s.enabled ? 'enabled' : 'disabled'}">${s.enabled ? '已启用' : '已禁用'}</span>
        </div>
      </div>
    </div>
  `).join('');
}

function renderDetailLogs(agent, container) {
  const logs = [
    { time: new Date().toLocaleString(), level: 'info', message: '子智能体详情已加载' },
    { time: new Date(Date.now() - 60000).toLocaleString(), level: 'info', message: '状态查询完成' },
  ];
  if (agent.status === 'running') {
    logs.unshift({ time: new Date(Date.now() - 120000).toLocaleString(), level: 'success', message: '子智能体已成功启动' });
  }
  container.innerHTML = `
    <div class="monitor-log-stream" style="max-height:300px;">
      ${logs.map(l => `
        <div class="log-entry">
          <span class="log-time">${l.time}</span>
          <span class="log-level ${l.level}">${l.level.toUpperCase()}</span>
          <span class="log-message">${l.message}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderDetailSecurity(agent, container) {
  container.innerHTML = `
    <div class="safety-report" style="flex-direction:column;gap:12px;">
      <div class="detail-item full-width">
        <span class="detail-label">安全等级</span>
        <span class="detail-value">🔒 ${agent.safetyLevel || 'medium'}</span>
      </div>
      <div class="detail-item full-width">
        <span class="detail-label">沙箱状态</span>
        <span class="detail-value ${agent.safetyLevel === 'high' || agent.safetyLevel === 'maximum' ? 'text-ok' : 'text-warn'}">
          ${agent.safetyLevel === 'high' || agent.safetyLevel === 'maximum' ? '✅ 已启用沙箱隔离' : '⚠️ 沙箱未启用'}
        </span>
      </div>
      <div class="detail-item full-width">
        <span class="detail-label">违规次数</span>
        <span class="detail-value text-ok">0</span>
      </div>
      <div class="detail-item full-width">
        <span class="detail-label">安全评分</span>
        <span class="detail-value text-ok">100/100</span>
      </div>
      <div class="detail-item full-width">
        <span class="detail-label">审计日志</span>
        <span class="detail-value text-ok">✅ 已启用</span>
      </div>
    </div>
  `;
}

async function toggleAgentFromDetail() {
  const agent = STATE.agents.find(a => a.id === STATE.selectedAgentId);
  if (!agent) return;
  const action = agent.status === 'running' ? 'stop' : 'start';
  await toggleAgent(agent.id, action);
  closeAgentDetail();
}

function openAgentChatFromDetail() {
  const agent = STATE.agents.find(a => a.id === STATE.selectedAgentId);
  if (!agent) return;
  closeAgentDetail();
  openAgentChatWindow(agent.id, agent.name);
}

// ═══════════════════════════════════════
// 智能体操作
// ═══════════════════════════════════════

async function toggleAgent(agentId, action) {
  const agent = STATE.agents.find(a => a.id === agentId);
  if (!agent) return;

  try {
    if (API) {
      const result = action === 'stop' ? await API.stopSubAgent(agentId) : await API.startSubAgent(agentId);
      if (result?.success) {
        agent.status = action === 'stop' ? 'stopped' : 'running';
        showToast(`子智能体已${action === 'stop' ? '停止' : '启动'}`, 'success');
      } else {
        showToast(`操作失败: ${result?.error || '未知错误'}`, 'error');
      }
    } else {
      agent.status = action === 'stop' ? 'stopped' : 'running';
      showToast(`子智能体已${action === 'stop' ? '停止' : '启动'}（演示模式）`, 'success');
    }
    await refreshAll();
    if (STATE.currentView === 'list') filterAgentList();
  } catch (e) {
    showToast(`操作失败: ${e.message}`, 'error');
  }
}

async function deleteAgent(agentId) {
  const agent = STATE.agents.find(a => a.id === agentId);
  if (!agent) return;

  showConfirmModal(
    `确认删除子智能体 "${agent.name}"？`,
    '此操作不可撤销，所有相关会话和数据将被永久删除。',
    async () => {
      try {
        if (API?.deleteSubAgent) {
          const result = await API.deleteSubAgent(agentId);
          if (result?.success) {
            STATE.agents = STATE.agents.filter(a => a.id !== agentId);
            showToast(`子智能体 "${agent.name}" 已删除`, 'success');
          }
        } else {
          STATE.agents = STATE.agents.filter(a => a.id !== agentId);
          showToast(`子智能体 "${agent.name}" 已删除（演示模式）`, 'success');
        }
        await refreshAll();
        if (STATE.currentView === 'list') filterAgentList();
      } catch (e) {
        showToast(`删除失败: ${e.message}`, 'error');
      }
    }
  );
}

// ═══════════════════════════════════════
// 子智能体对话
// ═══════════════════════════════════════

function openAgentChatWindow(agentId, agentName) {
  STATE.chat.activeAgentId = agentId;
  STATE.chat.activeAgentName = agentName;
  STATE.chat.activeSessionId = null;
  STATE.chat.sessions = [];
  STATE.chat.messages = [];

  const modal = $('agent-chat-modal');
  if (!modal) return;

  setText('agent-chat-title', `💬 ${agentName || agentId}`);
  modal.style.display = 'flex';

  // 加载会话
  loadAgentChatSessions();
  renderAgentChatMessages();

  setTimeout(() => {
    const input = $('agent-chat-input');
    if (input) input.focus();
  }, 100);
}

function closeAgentChat() {
  const modal = $('agent-chat-modal');
  if (modal) modal.style.display = 'none';
  STATE.chat.activeAgentId = null;
  STATE.chat.activeSessionId = null;
}

function loadAgentChatSessions() {
  // 模拟会话数据
  STATE.chat.sessions = [
    { id: 'sess_1', name: '数据分析讨论', messageCount: 12, createdAt: new Date().toISOString(), isActive: true },
    { id: 'sess_2', name: '代码审查会话', messageCount: 5, createdAt: new Date(Date.now() - 86400000).toISOString() },
    { id: 'sess_3', name: '文档编写任务', messageCount: 8, createdAt: new Date(Date.now() - 172800000).toISOString() },
  ];

  if (!STATE.chat.activeSessionId) {
    const active = STATE.chat.sessions.find(s => s.isActive);
    STATE.chat.activeSessionId = active ? active.id : STATE.chat.sessions[0]?.id;
  }

  renderAgentChatSessions();
}

function renderAgentChatSessions() {
  const container = $('agent-chat-sessions');
  if (!container) return;

  if (STATE.chat.sessions.length === 0) {
    container.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:11px;">暂无会话</div>';
    return;
  }

  container.innerHTML = STATE.chat.sessions.map(s => `
    <div class="session-item ${s.id === STATE.chat.activeSessionId ? 'active' : ''}" onclick="switchAgentChatSession('${s.id}')">
      <div class="session-item-name">${escapeHtml(s.name)}</div>
      <div class="session-item-meta">
        <span>${s.messageCount} 条</span>
        <span>${s.createdAt ? new Date(s.createdAt).toLocaleDateString() : ''}</span>
      </div>
    </div>
  `).join('');
}

function switchAgentChatSession(sessionId) {
  STATE.chat.activeSessionId = sessionId;
  renderAgentChatSessions();
  loadAgentChatMessages(sessionId);
}

function loadAgentChatMessages(sessionId) {
  // 模拟消息数据
  const demoMessages = {
    sess_1: [
      { role: 'user', content: '请分析一下这个季度的销售数据', timestamp: Date.now() - 300000 },
      { role: 'assistant', content: '好的，我来分析销售数据。从数据来看，Q3整体表现良好，增长率达12.5%，其中电子产品类别增长最为显著，达18%。', timestamp: Date.now() - 280000, metadata: { responseTime: 2500, reasoningMode: 'chain-of-thought' } },
      { role: 'user', content: '具体哪些产品表现最好？', timestamp: Date.now() - 200000 },
      { role: 'assistant', content: '表现最好的产品包括：\n1. 智能手表 - 增长35%\n2. 无线耳机 - 增长28%\n3. 平板电脑 - 增长22%\n\n这些产品占据了总增长的65%。', timestamp: Date.now() - 180000, metadata: { responseTime: 1800, reasoningMode: 'direct' } },
    ],
    sess_2: [
      { role: 'user', content: '帮我审查一下最新的PR代码', timestamp: Date.now() - 3600000 },
      { role: 'assistant', content: '已审查PR #234。发现以下问题：\n1. 存在潜在的内存泄漏风险（src/core/handler.js:145）\n2. 缺少错误边界处理\n3. 建议优化循环逻辑以提高性能\n\n整体代码质量良好，建议修复上述问题后合并。', timestamp: Date.now() - 3500000 },
    ],
  };

  STATE.chat.messages = demoMessages[sessionId] || [];
  renderAgentChatMessages();
}

function renderAgentChatMessages() {
  const container = $('agent-chat-messages');
  if (!container) return;

  if (STATE.chat.messages.length === 0) {
    container.innerHTML = '<div class="chat-empty">选择或新建一个会话开始对话</div>';
    return;
  }

  container.innerHTML = STATE.chat.messages.map(m => {
    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
    const roleClass = m.role === 'user' ? 'msg-user' : m.role === 'assistant' ? 'msg-assistant' : m.role === 'error' ? 'msg-error' : 'msg-system';
    const avatar = m.role === 'user' ? '👤' : m.role === 'assistant' ? '🤖' : m.role === 'error' ? '⚠️' : '📋';

    const metaHtml = m.role === 'assistant' && m.metadata
      ? `<div class="msg-metadata">⏱ ${m.metadata.responseTime || 0}ms | 🧠 ${m.metadata.reasoningMode || 'direct'}</div>`
      : '';

    return `
      <div class="chat-message ${roleClass}">
        <div class="msg-header">
          <span class="msg-avatar">${avatar}</span>
          <span class="msg-time">${time}</span>
        </div>
        <div class="msg-content">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
        ${metaHtml}
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function agentChatNewSession() {
  const newSession = {
    id: 'sess_' + Date.now(),
    name: `会话 ${STATE.chat.sessions.length + 1}`,
    messageCount: 0,
    createdAt: new Date().toISOString(),
    isActive: true,
  };
  STATE.chat.sessions.unshift(newSession);
  STATE.chat.activeSessionId = newSession.id;
  STATE.chat.messages = [];
  renderAgentChatSessions();
  renderAgentChatMessages();
  showToast('新会话已创建', 'success');
}

function agentChatClear() {
  if (!STATE.chat.activeSessionId) return;
  showConfirmModal('确认清空当前会话？', '所有消息将被永久删除。', () => {
    STATE.chat.messages = [];
    const session = STATE.chat.sessions.find(s => s.id === STATE.chat.activeSessionId);
    if (session) session.messageCount = 0;
    renderAgentChatMessages();
    renderAgentChatSessions();
    showToast('会话已清空', 'info');
  });
}

async function agentChatSend() {
  const input = $('agent-chat-input');
  if (!input) return;

  const content = input.value.trim();
  if (!content) return;

  // 确保有活跃会话
  if (!STATE.chat.activeSessionId) {
    agentChatNewSession();
  }

  input.value = '';
  input.disabled = true;

  // 添加用户消息
  const userMsg = { role: 'user', content, timestamp: Date.now() };
  STATE.chat.messages.push(userMsg);
  const session = STATE.chat.sessions.find(s => s.id === STATE.chat.activeSessionId);
  if (session) session.messageCount = (session.messageCount || 0) + 1;
  renderAgentChatMessages();

  // 更新引擎状态
  const indicator = $('agent-chat-engine')?.querySelector('.engine-indicator');
  if (indicator) {
    indicator.textContent = '● 思考中...';
    indicator.style.color = 'var(--accent-yellow)';
  }

  try {
    if (API?.sendMessageToSubAgent) {
      const result = await API.sendMessageToSubAgent(STATE.chat.activeAgentId, content, STATE.chat.activeSessionId);
      if (result?.success) {
        // 模拟回复
        const reply = generateDemoReply(content);
        STATE.chat.messages.push({ role: 'assistant', content: reply, timestamp: Date.now(), metadata: { responseTime: Math.floor(Math.random() * 2000 + 500), reasoningMode: 'chain-of-thought' } });
        if (session) session.messageCount++;
      }
    } else {
      // 演示模式：模拟回复
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1500));
      const reply = generateDemoReply(content);
      STATE.chat.messages.push({ role: 'assistant', content: reply, timestamp: Date.now(), metadata: { responseTime: Math.floor(Math.random() * 2000 + 500), reasoningMode: 'chain-of-thought' } });
      if (session) session.messageCount++;
    }
  } catch (e) {
    STATE.chat.messages.push({ role: 'error', content: `发送失败: ${e.message}`, timestamp: Date.now() });
  }

  renderAgentChatMessages();
  renderAgentChatSessions();
  input.disabled = false;
  input.focus();

  if (indicator) {
    indicator.textContent = '● 就绪';
    indicator.style.color = 'var(--accent-green)';
  }
}

function generateDemoReply(content) {
  if (/分析|数据|报告/i.test(content)) return `已收到你的分析请求。基于当前数据，我正在进行多维度分析：\n\n1. **趋势分析**：数据呈现稳定增长态势\n2. **异常检测**：未发现明显异常值\n3. **关键指标**：核心KPI均处于健康区间\n\n需要我进一步深入某个维度吗？`;
  if (/代码|编程|写一个|实现/i.test(content)) return `收到编程请求。我来分析一下需求并给出实现方案：\n\n\`\`\`javascript\n// 建议的实现思路\nfunction solution(input) {\n  // 处理逻辑\n  return result;\n}\n\`\`\`\n\n这个方案考虑到了性能和可维护性，需要我详细展开吗？`;
  if (/帮助|help|功能/i.test(content)) return `我可以帮助你完成以下任务：\n\n• 📊 数据分析和报告生成\n• 💻 代码编写和审查\n• 📝 文档撰写和翻译\n• 🔍 信息搜索和整理\n• ⚡ 自动化任务执行\n\n请告诉我你需要什么帮助？`;
  return `已收到你的消息。我正在利用我的专业能力来理解和处理你的请求。请稍候，我会给你一个详细的分析和回复。`;
}

// ═══════════════════════════════════════
// 团队管理
// ═══════════════════════════════════════

function refreshTeams() {
  refreshTeamsData().then(() => renderTeams());
}

function renderTeams() {
  const container = $('team-grid');
  if (!container) return;

  if (STATE.teams.length === 0) {
    container.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">暂无团队，点击上方按钮创建</div>';
    return;
  }

  const typeNames = { task_force: '任务执行', discussion: '讨论组', pipeline: '流水线', custom: '自定义' };

  container.innerHTML = STATE.teams.map(t => `
    <div class="team-card">
      <div class="team-card-header">
        <div class="team-card-name">👥 ${escapeHtml(t.name || '未命名')}</div>
        <span class="team-card-type-badge">${typeNames[t.type] || t.type}</span>
      </div>
      <div class="team-card-goal">${escapeHtml(t.goal || '暂无目标')}</div>
      <div class="team-card-members">
        ${(t.members || []).slice(0, 6).map(m => {
          const icons = { assistant: '🔧', analyst: '📊', executor: '⚡', monitor: '🛡', custom: '🎨' };
          return `<span class="team-member-avatar" title="${escapeHtml(m.name)}">${icons[m.type] || '🤖'}</span>`;
        }).join('')}
        ${(t.members || []).length > 6 ? `<span style="font-size:12px;color:var(--text-muted);">+${t.members.length - 6}</span>` : ''}
      </div>
      <div class="team-card-footer">
        <button class="btn-mini btn-chat">💬 协作</button>
        <button class="btn-mini">📋 任务</button>
        <button class="btn-mini btn-danger">🗑 解散</button>
      </div>
    </div>
  `).join('');
}

function openTeamCreator() {
  const modal = $('team-create-modal');
  if (!modal) return;

  // 填充成员选择
  const memberList = $('team-member-select');
  if (memberList) {
    memberList.innerHTML = STATE.agents.filter(a => a.status === 'running').map(a => `
      <label class="member-select-item">
        <input type="checkbox" value="${a.id}">
        <span>🤖 ${escapeHtml(a.name)}</span>
        <span style="color:var(--text-muted);font-size:11px;">${a.type || '通用'}</span>
      </label>
    `).join('') || '<div style="padding:8px;color:var(--text-muted);">暂无可用子智能体</div>';
  }

  modal.style.display = 'flex';
}

function closeTeamCreator() {
  const modal = $('team-create-modal');
  if (modal) modal.style.display = 'none';
}

async function confirmCreateTeam() {
  const name = $('team-name')?.value.trim();
  const type = $('team-type')?.value;
  const goal = $('team-goal')?.value.trim();
  const coordination = $('team-coordination')?.value;
  const requireConsent = $('team-require-consent')?.checked;
  const selectedMembers = Array.from(document.querySelectorAll('#team-member-select input:checked')).map(cb => cb.value);

  if (!name) { showToast('请输入团队名称', 'warning'); return; }
  if (selectedMembers.length === 0) { showToast('请至少选择一个成员', 'warning'); return; }

  const newTeam = {
    id: 'team_' + Date.now(),
    name, type, goal, coordination, requireConsent,
    members: STATE.agents.filter(a => selectedMembers.includes(a.id)).map(a => ({ id: a.id, name: a.name, type: a.type })),
    createdAt: new Date().toISOString(),
  };

  STATE.teams.unshift(newTeam);
  showToast(`团队 "${name}" 创建成功！`, 'success');
  closeTeamCreator();
  renderTeams();
  updateSidebarStats();
}

// ═══════════════════════════════════════
// 技能管理
// ═══════════════════════════════════════

function switchSkillTab(tab) {
  STATE.skillTab = tab;
  document.querySelectorAll('.skill-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  refreshSkillView();
}

async function refreshSkillView() {
  const container = $('skill-content-area');
  if (!container) return;

  // 更新智能体筛选
  const filter = $('skill-agent-filter');
  if (filter && filter.options.length <= 1) {
    filter.innerHTML = '<option value="all">全部子智能体</option>' +
      STATE.agents.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  }

  const agentFilter = filter?.value || 'all';
  let skills = STATE.skills;
  if (agentFilter !== 'all') {
    skills = skills.filter(s => s.agentId === agentFilter);
  }

  if (STATE.skillTab === 'market') {
    skills = generateDemoMarketSkills();
  } else if (STATE.skillTab === 'pending') {
    skills = skills.filter(s => s.status === 'pending');
  }

  if (skills.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无技能数据</div>';
    return;
  }

  container.innerHTML = skills.map(s => `
    <div class="skill-card">
      <div class="skill-card-info">
        <div class="skill-card-name">${escapeHtml(s.name || '未命名')}</div>
        <div class="skill-card-desc">${escapeHtml(s.description || '无描述')}</div>
        <div class="skill-card-meta">
          <span class="skill-badge category">${s.category || '通用'}</span>
          <span class="skill-badge version">v${s.version || '1.0'}</span>
          ${s.enabled !== undefined ? `<span class="skill-badge ${s.enabled ? 'enabled' : 'disabled'}">${s.enabled ? '已启用' : '已禁用'}</span>` : ''}
          ${s.author ? `<span>👤 ${s.author}</span>` : ''}
          ${s.downloads ? `<span>⬇ ${s.downloads}</span>` : ''}
        </div>
      </div>
      <div class="skill-card-actions">
        ${STATE.skillTab === 'market'
          ? `<button class="btn-mini btn-success" onclick="installMarketSkill('${s.id}')">安装</button>`
          : `<button class="btn-mini" onclick="toggleSkill('${s.id}')">${s.enabled ? '禁用' : '启用'}</button>
             <button class="btn-mini btn-danger" onclick="uninstallSkill('${s.id}')">卸载</button>`}
      </div>
    </div>
  `).join('');
}

function openSkillInstaller() {
  const modal = $('skill-install-modal');
  if (!modal) return;

  // 填充目标智能体列表
  const agentSelects = ['skill-target-agent-market', 'skill-target-agent-file', 'skill-target-agent-paste'];
  agentSelects.forEach(id => {
    const select = document.getElementById(id);
    if (select) {
      select.innerHTML = '<option value="">选择目标子智能体...</option>' +
        STATE.agents.map(a => `<option value="${a.id}">${escapeHtml(a.name)} (${a.type || '通用'})</option>`).join('');
    }
  });

  // 渲染市场列表
  renderSkillMarketList();

  STATE.installMethod = 'market';
  switchInstallMethod('market');
  modal.style.display = 'flex';
}

function closeSkillInstaller() {
  const modal = $('skill-install-modal');
  if (modal) modal.style.display = 'none';
}

function switchInstallMethod(method) {
  STATE.installMethod = method;
  document.querySelectorAll('.install-method-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.method === method);
  });
  document.querySelectorAll('.install-method-content').forEach(c => c.classList.remove('active'));
  const content = $(`install-method-${method}`);
  if (content) content.classList.add('active');
}

function renderSkillMarketList() {
  const container = $('skill-market-list');
  if (!container) return;

  const marketSkills = generateDemoMarketSkills();
  container.innerHTML = marketSkills.map(s => `
    <div class="market-skill-card">
      <div class="market-skill-info">
        <div class="market-skill-name">${escapeHtml(s.name)}</div>
        <div class="market-skill-desc">${escapeHtml(s.description || '')}</div>
        <div class="market-skill-meta">
          <span>📦 ${s.category}</span>
          <span>⭐ v${s.version}</span>
          <span>👤 ${s.author}</span>
          <span>⬇ ${s.downloads}</span>
        </div>
      </div>
      <button class="btn-primary btn-mini" style="white-space:nowrap;" onclick="installMarketSkill('${s.id}')">安装</button>
    </div>
  `).join('');
}

function handleSkillFileSelect(event) {
  const file = event.target.files?.[0];
  if (file) {
    showToast(`已选择文件: ${file.name}`, 'info');
  }
}

async function confirmInstallSkill() {
  let agentId;
  if (STATE.installMethod === 'market') agentId = $('skill-target-agent-market')?.value;
  else if (STATE.installMethod === 'file') agentId = $('skill-target-agent-file')?.value;
  else if (STATE.installMethod === 'paste') agentId = $('skill-target-agent-paste')?.value;

  if (!agentId) { showToast('请选择目标子智能体', 'warning'); return; }

  const newSkill = {
    id: 'skill_' + Date.now(),
    name: '新安装技能',
    description: '通过' + ({ market: '市场', file: '文件', paste: '粘贴' }[STATE.installMethod]) + '安装',
    category: '通用',
    version: '1.0',
    enabled: true,
    agentId,
  };

  STATE.skills.unshift(newSkill);
  showToast('技能安装成功！', 'success');
  closeSkillInstaller();
  refreshSkillView();
  updateSidebarStats();
}

function installMarketSkill(skillId) {
  const marketSkill = generateDemoMarketSkills().find(s => s.id === skillId);
  if (marketSkill) {
    STATE.skills.unshift({ ...marketSkill, enabled: true, agentId: 'all' });
    showToast(`技能 "${marketSkill.name}" 安装成功！`, 'success');
    refreshSkillView();
    updateSidebarStats();
  }
}

function toggleSkill(skillId) {
  const skill = STATE.skills.find(s => s.id === skillId);
  if (skill) {
    skill.enabled = !skill.enabled;
    showToast(`技能已${skill.enabled ? '启用' : '禁用'}`, 'info');
    refreshSkillView();
  }
}

function uninstallSkill(skillId) {
  const skill = STATE.skills.find(s => s.id === skillId);
  if (!skill) return;
  showConfirmModal(`确认卸载技能 "${skill.name}"？`, '卸载后需要重新安装才能使用。', () => {
    STATE.skills = STATE.skills.filter(s => s.id !== skillId);
    showToast(`技能 "${skill.name}" 已卸载`, 'info');
    refreshSkillView();
    updateSidebarStats();
  });
}

// ═══════════════════════════════════════
// 监控中心
// ═══════════════════════════════════════

function switchMonitorTab(tab) {
  STATE.monitorTab = tab;
  document.querySelectorAll('.monitor-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  refreshMonitorView();
}

function refreshMonitorView() {
  if (STATE.monitorPaused) return;
  if (STATE.currentView !== 'monitor') return;

  const container = $('monitor-log-stream');
  if (!container) return;

  // 模拟日志
  const levels = ['info', 'info', 'info', 'debug', 'debug', 'warn', 'success'];
  const agents = STATE.agents.filter(a => a.status === 'running');
  const agentNames = agents.length > 0 ? agents.map(a => a.name) : ['系统'];

  const messages = [
    '状态检查完成，所有指标正常',
    '接收到新的用户请求',
    '开始处理消息队列',
    '工具调用: web_search',
    '记忆检索完成，命中3条相关记忆',
    'API响应时间: 245ms',
    '会话上下文更新完成',
    '技能调用: data_analysis',
    'Token使用量更新',
    '心跳检测正常',
  ];

  const level = levels[Math.floor(Math.random() * levels.length)];
  const agent = agentNames[Math.floor(Math.random() * agentNames.length)];
  const msg = messages[Math.floor(Math.random() * messages.length)];
  const now = new Date().toLocaleTimeString();

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">${now}</span>
    <span class="log-level ${level}">${level.toUpperCase()}</span>
    <span class="log-agent">${agent}</span>
    <span class="log-message">${msg}</span>
  `;

  container.insertBefore(entry, container.firstChild);

  // 限制日志数量
  while (container.children.length > 200) {
    container.removeChild(container.lastChild);
  }

  // 移除空状态
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  setText('footer-events', `事件: ${container.children.length}`);
}

function toggleMonitorPause() {
  STATE.monitorPaused = !STATE.monitorPaused;
  const btn = $('btn-monitor-pause');
  if (btn) {
    btn.textContent = STATE.monitorPaused ? '▶ 恢复' : '⏸ 暂停';
  }
}

function clearMonitorLogs() {
  const container = $('monitor-log-stream');
  if (container) {
    container.innerHTML = '<div class="empty-state">日志已清空，等待新事件...</div>';
  }
}

// ═══════════════════════════════════════
// 安全审计
// ═══════════════════════════════════════

function refreshSecurityView() {
  const tbody = $('security-table-body');
  if (!tbody) return;

  // 模拟安全事件
  const events = [
    { time: new Date(Date.now() - 300000).toLocaleString(), agent: '数据分析助手', type: '权限检查', severity: 'low', desc: '文件读取权限验证通过', result: '允许' },
    { time: new Date(Date.now() - 600000).toLocaleString(), agent: '代码审查员', type: '沙箱检查', severity: 'low', desc: '代码执行环境沙箱验证', result: '通过' },
    { time: new Date(Date.now() - 1200000).toLocaleString(), agent: '任务执行器', type: 'API限流', severity: 'medium', desc: 'API调用频率接近阈值', result: '限速' },
    { time: new Date(Date.now() - 1800000).toLocaleString(), agent: '监控守护', type: '安全扫描', severity: 'low', desc: '定期安全扫描完成，未发现威胁', result: '正常' },
  ];

  tbody.innerHTML = events.map(e => `
    <tr>
      <td>${e.time}</td>
      <td>${escapeHtml(e.agent)}</td>
      <td>${e.type}</td>
      <td class="severity-${e.severity}">${e.severity === 'low' ? '低' : e.severity === 'medium' ? '中' : e.severity === 'high' ? '高' : '严重'}</td>
      <td>${escapeHtml(e.desc)}</td>
      <td>${e.result}</td>
    </tr>
  `).join('');
}

// ═══════════════════════════════════════
// 确认对话框
// ═══════════════════════════════════════

function showConfirmModal(title, message, onConfirm) {
  const modal = $('confirm-modal');
  if (!modal) return;

  setText('confirm-title', title);
  $('confirm-body').innerHTML = `<p style="color:var(--text-secondary);font-size:14px;">${message}</p>`;

  const btnOk = $('btn-confirm-ok');
  const btnCancel = $('btn-confirm-cancel');

  btnOk.onclick = () => {
    closeConfirmModal();
    if (onConfirm) onConfirm();
  };
  btnCancel.onclick = closeConfirmModal;

  modal.style.display = 'flex';
}

function closeConfirmModal() {
  const modal = $('confirm-modal');
  if (modal) modal.style.display = 'none';
}

// ═══════════════════════════════════════
// Toast 通知
// ═══════════════════════════════════════

function showToast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = `${icons[type] || ''} ${message}`;
  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 4000);
}

// ═══════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════
// 演示数据生成
// ═══════════════════════════════════════

function generateDemoAgents() {
  return [
    {
      id: 'agent_001', name: '数据分析助手', type: 'analyst',
      description: '专门负责数据分析、报表生成和数据可视化。支持 CSV、Excel、JSON 等多种格式。',
      status: 'running', safetyLevel: 'medium', quota: 'medium',
      model: 'gpt-4o', reasoning: 'chain-of-thought',
      createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
      sessionCount: 24, messageCount: 356, skillCount: 3,
      lastActive: new Date(Date.now() - 300000).toISOString(),
    },
    {
      id: 'agent_002', name: '代码审查员', type: 'executor',
      description: '负责代码审查、静态分析和安全漏洞检测。支持多种编程语言。',
      status: 'running', safetyLevel: 'high', quota: 'medium',
      model: 'claude-3.5', reasoning: 'chain-of-thought',
      createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      sessionCount: 18, messageCount: 234, skillCount: 2,
      lastActive: new Date(Date.now() - 600000).toISOString(),
    },
    {
      id: 'agent_003', name: '文档撰写员', type: 'assistant',
      description: '负责技术文档撰写、API文档生成和多语言翻译。',
      status: 'stopped', safetyLevel: 'low', quota: 'low',
      model: 'deepseek-v3', reasoning: 'direct',
      createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      sessionCount: 8, messageCount: 89, skillCount: 1,
      lastActive: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 'agent_004', name: '监控守护', type: 'monitor',
      description: '7x24小时系统监控、异常检测和自动告警。',
      status: 'running', safetyLevel: 'maximum', quota: 'low',
      model: 'qwen-max', reasoning: 'reflexion',
      createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      sessionCount: 2, messageCount: 45, skillCount: 2,
      lastActive: new Date(Date.now() - 120000).toISOString(),
    },
    {
      id: 'agent_005', name: '任务执行器', type: 'executor',
      description: '批量任务执行、自动化工作流编排和脚本运行。',
      status: 'pending', safetyLevel: 'medium', quota: 'high',
      model: 'glm-4', reasoning: 'tree-of-thought',
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      sessionCount: 0, messageCount: 0, skillCount: 0,
    },
    {
      id: 'agent_006', name: '翻译助手', type: 'custom',
      description: '多语言翻译、本地化适配和跨文化交流支持。',
      status: 'running', safetyLevel: 'low', quota: 'medium',
      model: 'auto', reasoning: 'direct',
      createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      sessionCount: 32, messageCount: 567, skillCount: 4,
      lastActive: new Date(Date.now() - 900000).toISOString(),
    },
  ];
}

function generateDemoTeams() {
  return [
    {
      id: 'team_001', name: '数据分析特战队', type: 'task_force',
      goal: '协同完成复杂的数据分析任务，分工明确高效协作',
      members: [
        { id: 'agent_001', name: '数据分析助手', type: 'analyst' },
        { id: 'agent_006', name: '翻译助手', type: 'custom' },
      ],
      coordination: 'round_robin',
      createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    },
    {
      id: 'team_002', name: '代码质量保障组', type: 'pipeline',
      goal: '代码审查→安全扫描→文档生成流水线',
      members: [
        { id: 'agent_002', name: '代码审查员', type: 'executor' },
        { id: 'agent_003', name: '文档撰写员', type: 'assistant' },
      ],
      coordination: 'hierarchical',
      createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    },
  ];
}

function generateDemoSkills() {
  return [
    { id: 'skill_001', name: '基础对话引擎', description: '提供自然语言理解和对话生成能力', category: 'core', version: '2.1', enabled: true, agentId: 'agent_001' },
    { id: 'skill_002', name: '数据可视化工具', description: '将分析结果转化为可视化图表', category: 'analysis', version: '1.5', enabled: true, agentId: 'agent_001' },
    { id: 'skill_003', name: '代码安全扫描', description: '自动检测代码中的安全漏洞', category: 'security', version: '3.0', enabled: true, agentId: 'agent_002' },
    { id: 'skill_004', name: 'API文档生成器', description: '从代码注释自动生成API文档', category: 'documentation', version: '1.2', enabled: false, agentId: 'agent_003' },
    { id: 'skill_005', name: '异常检测引擎', description: '基于机器学习的实时异常检测', category: 'monitoring', version: '2.3', enabled: true, agentId: 'agent_004' },
    { id: 'skill_006', name: '多语言翻译', description: '支持50+语言的实时翻译', category: 'translation', version: '1.8', enabled: true, agentId: 'agent_006' },
    { id: 'skill_007', name: '情感分析器', description: '分析文本中的情感倾向和强度', category: 'analysis', version: '1.1', enabled: false, agentId: 'agent_001' },
  ];
}

function generateDemoMarketSkills() {
  return [
    { id: 'market_001', name: 'SQL查询优化器', description: '自动分析和优化SQL查询性能', category: '数据库', version: '2.0', author: 'DataTeam', downloads: 1520 },
    { id: 'market_002', name: '图片识别助手', description: '基于视觉模型的图像内容识别', category: 'AI视觉', version: '1.3', author: 'VisionLab', downloads: 2340 },
    { id: 'market_003', name: '爬虫自动化', description: '智能网页爬虫和数据提取', category: '自动化', version: '1.7', author: 'WebBot', downloads: 980 },
    { id: 'market_004', name: '单元测试生成器', description: '自动生成单元测试用例', category: '测试', version: '2.2', author: 'TestMaster', downloads: 1850 },
    { id: 'market_005', name: 'PDF智能处理', description: 'PDF文件解析、转换和内容提取', category: '文档处理', version: '1.5', author: 'DocPro', downloads: 3100 },
    { id: 'market_006', name: '会议纪要生成', description: '自动生成结构化会议纪要', category: '办公', version: '1.0', author: 'MeetingAI', downloads: 750 },
  ];
}

// ═══════════════════════════════════════
// 暴露到全局
// ═══════════════════════════════════════

window.switchView = switchView;
window.setListLayout = setListLayout;
window.filterAgentList = filterAgentList;
window.refreshAgentList = refreshAgentList;
window.openCreateAgentWizard = openCreateAgentWizard;
window.closeCreateAgentWizard = closeCreateAgentWizard;
window.wizardNext = wizardNext;
window.wizardPrev = wizardPrev;
window.confirmCreateAgent = confirmCreateAgent;
window.openAgentDetail = openAgentDetail;
window.closeAgentDetail = closeAgentDetail;
window.switchDetailTab = switchDetailTab;
window.toggleAgentFromDetail = toggleAgentFromDetail;
window.openAgentChatFromDetail = openAgentChatFromDetail;
window.toggleAgent = toggleAgent;
window.deleteAgent = deleteAgent;
window.openAgentChatWindow = openAgentChatWindow;
window.closeAgentChat = closeAgentChat;
window.switchAgentChatSession = switchAgentChatSession;
window.agentChatNewSession = agentChatNewSession;
window.agentChatClear = agentChatClear;
window.agentChatSend = agentChatSend;
window.openTeamCreator = openTeamCreator;
window.closeTeamCreator = closeTeamCreator;
window.confirmCreateTeam = confirmCreateTeam;
window.refreshTeams = refreshTeams;
window.switchSkillTab = switchSkillTab;
window.refreshSkillView = refreshSkillView;
window.openSkillInstaller = openSkillInstaller;
window.closeSkillInstaller = closeSkillInstaller;
window.switchInstallMethod = switchInstallMethod;
window.handleSkillFileSelect = handleSkillFileSelect;
window.confirmInstallSkill = confirmInstallSkill;
window.installMarketSkill = installMarketSkill;
window.toggleSkill = toggleSkill;
window.uninstallSkill = uninstallSkill;
window.switchMonitorTab = switchMonitorTab;
window.refreshMonitorView = refreshMonitorView;
window.toggleMonitorPause = toggleMonitorPause;
window.clearMonitorLogs = clearMonitorLogs;
window.refreshSecurityView = refreshSecurityView;
window.toggleMessageStream = toggleMessageStream;
