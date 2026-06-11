/**
 * 蜜糖 TriCore Brain UI — 渲染进程逻辑
 *
 * 通过 window.triCoreAPI 与主进程通信
 * 实时更新三核状态、对话流、记忆流、子智能体管理
 */

'use strict';

// v1.0: Unified logging wrapper — 修复LOG递归bug，直接使用console
const LOG = {
  error: (...args) => { console.error('[BrainUI]', ...args); if (window.triCoreAPI?.logError) window.triCoreAPI.logError(args.join(' ')); },
  warn: (...args) => { console.warn('[BrainUI]', ...args); if (window.triCoreAPI?.logWarn) window.triCoreAPI.logWarn(args.join(' ')); },
  info: (...args) => { console.log('[BrainUI]', ...args); if (window.triCoreAPI?.logInfo) window.triCoreAPI.logInfo(args.join(' ')); },
  debug: (...args) => { if (window.triCoreAPI?.logDebug) window.triCoreAPI.logDebug(args.join(' ')); },
};

// ═══════════════════════════════════════
// API引用（由preload注入）
// ═══════════════════════════════════════

const API = window.triCoreAPI;

// ═══════════════════════════════════════
// 状态管理
// ═══════════════════════════════════════

const state = {
  agentStatus: null,
  chatMode: 'chat',     // chat | task
  refreshTimer: null,
  startTime: Date.now(),
  eventSubscriptions: [],
  ws: null,              // WebSocket 连接
  wsReconnectTimer: null,
  wsReconnectDelay: 1000, // 初始重连延迟 1s
  wsMaxReconnectDelay: 30000,
};

// ═══════════════════════════════════════
// DOM引用
// ═══════════════════════════════════════

const $ = (id) => document.getElementById(id);

const dom = {
  version: $('version'),
  // 指示灯
  indConsciousness: $('ind-consciousness'),
  indExecution: $('ind-execution'),
  indEvolution: $('ind-evolution'),
  indSubagents: $('ind-subagents'),
  // 意识核
  cMode: $('consciousness-mode'),
  cTicks: $('consciousness-ticks'),
  cAwakening: $('consciousness-awakening'),
  cFocus: $('consciousness-focus'),
  focusStack: $('focus-stack'),
  // 执行核
  eTasks: $('execution-tasks'),
  eCompleted: $('execution-completed'),
  eActive: $('execution-active'),
  eTools: $('execution-tools'),
  taskList: $('task-list'),
  // 进化核
  vSkills: $('evolution-skills'),
  vApproved: $('evolution-approved'),
  vPending: $('evolution-pending'),
  vConsolidation: $('evolution-consolidation'),
  skillList: $('skill-list'),
  // 对话
  chatMessages: $('chat-messages'),
  chatInput: $('chat-input'),
  btnSend: $('btn-send'),
  // 记忆
  memorySearch: $('memory-search'),
  memoryStream: $('memory-stream'),
  // 调度器
  sMode: $('scheduler-mode'),
  sCurrentMode: $('scheduler-current-mode'),
  sTickInterval: $('scheduler-tick-interval'),
  sQuota: $('scheduler-quota'),
  // 渠道
  channelList: $('channel-list'),
  // 路由
  rConsciousness: $('router-consciousness'),
  rExecution: $('router-execution'),
  rEvolution: $('router-evolution'),
  // 浏览器
  browserStatus: $('browser-status'),
  browserPage: $('browser-page'),
  // 子智能体
  subagentCount: $('subagent-count'),
  subagentActiveTotal: $('subagent-active-total'),
  subagentSafety: $('subagent-safety'),
  subagentList: $('subagent-list'),
  btnCreateSubagent: $('btn-create-subagent'),
  btnRefreshSubagents: $('btn-refresh-subagents'),
  // 底部栏
  footerStatus: $('footer-status'),
  footerMemory: $('footer-memory'),
  footerUptime: $('footer-uptime'),
  // 按钮
  btnPause: $('btn-pause'),
  btnResume: $('btn-resume'),
  btnSelfCheck: $('btn-self-check'),
};

// ═══════════════════════════════════════
// WebSocket 实时推送连接
// ═══════════════════════════════════════

function connectWebSocket() {
  // 如果已有连接，先清理
  if (state.ws) {
    try { state.ws.close(); } catch (e) { /* ignore */ }
    state.ws = null;
  }

  const wsUrl = `ws://${window.location.hostname || 'localhost'}:3721/ws`;
  LOG.info(`[WebSocket] 连接中: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    LOG.info('[WebSocket] 已连接');
    updateWsIndicator('connected');
    // 重置重连延迟
    state.wsReconnectDelay = 1000;
  };

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleWsMessage(payload);
    } catch (e) {
      LOG.warn('[WebSocket] 消息解析失败:', e.message);
    }
  };

  ws.onclose = (event) => {
    LOG.warn(`[WebSocket] 断开 (code=${event.code})`);
    updateWsIndicator('disconnected');
    state.ws = null;
    scheduleWsReconnect();
  };

  ws.onerror = (err) => {
    LOG.error('[WebSocket] 连接错误');
    updateWsIndicator('disconnected');
  };
}

function scheduleWsReconnect() {
  if (state.wsReconnectTimer) return;

  LOG.info(`[WebSocket] ${state.wsReconnectDelay}ms 后重连...`);
  state.wsReconnectTimer = setTimeout(() => {
    state.wsReconnectTimer = null;
    state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 1.5, state.wsMaxReconnectDelay);
    connectWebSocket();
  }, state.wsReconnectDelay);
}

function updateWsIndicator(status) {
  const el = document.getElementById('ws-indicator');
  if (!el) return;

  el.className = 'indicator ws-indicator ' + status;
  const label = el.querySelector('.label');
  const dot = el.querySelector('.dot');

  if (status === 'connected') {
    if (label) label.textContent = 'WS已连接';
  } else {
    if (label) label.textContent = 'WS断开';
  }
}

function handleWsMessage(payload) {
  const { type, data } = payload;

  switch (type) {
    case 'ai_response':
      // AI 响应推送
      if (data && data.content) {
        const role = data.role || 'agent';
        addChatMessage(role, data.content);
      }
      if (data && data.systemMessage) {
        addSystemMessage(data.systemMessage);
      }
      break;

    case 'task_update':
      // 任务状态更新
      if (data) {
        const taskEl = document.getElementById('execution-tasks');
        if (data.activeTasks !== undefined && taskEl) {
          taskEl.textContent = data.activeTasks;
        }
        if (data.completedTasks !== undefined) {
          const el = document.getElementById('execution-completed');
          if (el) el.textContent = data.completedTasks;
        }
        if (data.taskId && data.status) {
          const statusLabels = {
            pending: '⏳', running: '🔄', completed: '✅', failed: '❌',
          };
          addSystemMessage(`${statusLabels[data.status] || '📌'} 任务 ${data.taskId}: ${data.status}`);
        }
      }
      break;

    case 'memory_update':
      // 记忆更新推送
      if (data) {
        const memEl = document.getElementById('memory-stream');
        if (memEl && data.content) {
          const item = document.createElement('div');
          item.className = 'memory-item';
          item.innerHTML = `${data.content?.substring(0, 100) || '-'}
            <div class="memory-meta">${data.tier || '?'} · ${data.salience?.toFixed(1) || '-'} · ${data.source || 'ws'}</div>`;
          memEl.insertBefore(item, memEl.firstChild);
          // 限制记忆流条目数
          while (memEl.children.length > 50) {
            memEl.removeChild(memEl.lastChild);
          }
        }
        // 更新记忆计数
        if (data.totalMemories !== undefined) {
          const footerMem = document.getElementById('footer-memory');
          if (footerMem) footerMem.textContent = `记忆: ${data.totalMemories}`;
        }
      }
      break;

    case 'core_status':
      // 三核实时状态
      if (data) {
        updateCoreStatusFromWS(data);
      }
      break;

    case 'heartbeat':
      // 心跳响应
      break;

    default:
      LOG.debug('[WebSocket] 未处理的消息类型:', type);
  }
}

function updateCoreStatusFromWS(data) {
  // 意识核
  if (data.consciousness) {
    const c = data.consciousness;
    if (c.tickCounter !== undefined) {
      const el = document.getElementById('consciousness-ticks');
      if (el) el.textContent = c.tickCounter;
    }
    if (c.mode) {
      const el = document.getElementById('consciousness-mode');
      if (el) el.textContent = c.mode;
    }
    if (c.l1CacheHitRate !== undefined) {
      const el = document.getElementById('consciousness-l1-hitrate');
      if (el) el.textContent = (c.l1CacheHitRate * 100).toFixed(1) + '%';
    }
    if (c.activeState) {
      const el = document.getElementById('consciousness-active-state');
      if (el) el.textContent = c.activeState;
    }
  }

  // 执行核
  if (data.execution) {
    const e = data.execution;
    if (e.activeTasks !== undefined) {
      const el = document.getElementById('execution-tasks');
      if (el) el.textContent = e.activeTasks;
    }
    if (e.completedTasks !== undefined) {
      const el = document.getElementById('execution-completed');
      if (el) el.textContent = e.completedTasks;
    }
    if (e.completionRate !== undefined) {
      const el = document.getElementById('execution-completion-rate');
      if (el) el.textContent = (e.completionRate * 100).toFixed(1) + '%';
    }
    if (e.parallelTools !== undefined) {
      const el = document.getElementById('execution-parallel-tools');
      if (el) el.textContent = e.parallelTools;
    }
  }

  // 进化核
  if (data.evolution) {
    const ev = data.evolution;
    if (ev.approvedSkills !== undefined) {
      const el = document.getElementById('evolution-skills');
      if (el) el.textContent = ev.approvedSkills;
    }
    if (ev.pendingSkills !== undefined) {
      const el = document.getElementById('evolution-pending');
      if (el) el.textContent = ev.pendingSkills;
    }
    if (ev.lastConsolidationAt) {
      const ago = Math.round((Date.now() - ev.lastConsolidationAt) / 60000);
      const el = document.getElementById('evolution-consolidation');
      if (el) el.textContent = `${ago}分钟前`;
    }
  }
}

// ═══════════════════════════════════════
// 初始化
// ═══════════════════════════════════════

async function init() {
  // v5.0: 初始化设置管理器
  await initSettings();

  // v6.0: 首次启动检测 — 自动弹出配置向导
  await checkFirstRun();

  // 绑定事件
  bindEvents();

  // v3.0: 绑定消息处理器和记忆网络图事件
  bindMessageProcessorEvents();
  bindMemoryGraphEvents();

  // 订阅Agent事件
  subscribeAgentEvents();

  // 首次刷新
  await refreshStatus();
  await refreshMessageProcessor();
  await refreshMemoryGraphPanel();

  // 定时刷新
  state.refreshTimer = setInterval(refreshStatus, 3000);
  setInterval(refreshMessageProcessor, 5000);
  setInterval(refreshMemoryGraphPanel, 8000);

  // 更新运行时间
  setInterval(updateUptime, 1000);

  // WebSocket 实时连接
  connectWebSocket();
  // 心跳保活
  setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);

  LOG.info('[蜜糖 TriCore Brain UI] 初始化完成');
}

// v3.0: 消息处理器面板事件绑定
function bindMessageProcessorEvents() {
  const btnDetail = document.getElementById('btn-msgp-detail');
  const btnDAG = document.getElementById('btn-msgp-dag');
  const btnCloseDetail = document.getElementById('btn-close-msgp-detail');
  const btnCloseDAG = document.getElementById('btn-close-msgp-dag');
  const btnRefreshDetail = document.getElementById('btn-msgp-refresh-detail');
  const detailOverlay = document.getElementById('msgp-detail-modal');
  const dagOverlay = document.getElementById('msgp-dag-modal');

  if (btnDetail) btnDetail.addEventListener('click', openMessagePipelineDetail);
  if (btnDAG) btnDAG.addEventListener('click', openMessageDAGView);
  if (btnCloseDetail) btnCloseDetail.addEventListener('click', closeMessagePipelineDetail);
  if (btnCloseDAG) btnCloseDAG.addEventListener('click', closeMessageDAGView);
  if (btnRefreshDetail) btnRefreshDetail.addEventListener('click', openMessagePipelineDetail);

  if (detailOverlay) detailOverlay.addEventListener('click', (e) => {
    if (e.target === detailOverlay) closeMessagePipelineDetail();
  });
  if (dagOverlay) dagOverlay.addEventListener('click', (e) => {
    if (e.target === dagOverlay) closeMessageDAGView();
  });
}

// v3.0: 记忆网络图面板事件绑定
function bindMemoryGraphEvents() {
  const btnRefresh = document.getElementById('btn-memgraph-refresh');
  const btnFull = document.getElementById('btn-memgraph-full');
  const btnLayout = document.getElementById('btn-memgraph-layout');
  const btnCloseFull = document.getElementById('btn-close-memgraph-full');
  const btnFit = document.getElementById('btn-memgraph-fit');
  const fullOverlay = document.getElementById('memgraph-full-modal');

  const layoutSelect = document.getElementById('memgraph-layout-select');
  const clusterSelect = document.getElementById('memgraph-cluster-select');
  const gravitySlider = document.getElementById('memgraph-gravity-slider');
  const repulsionSlider = document.getElementById('memgraph-repulsion-slider');
  const linkSlider = document.getElementById('memgraph-link-slider');

  if (btnRefresh) btnRefresh.addEventListener('click', refreshMemoryGraphPanel);
  if (btnFull) btnFull.addEventListener('click', openFullMemoryGraph);
  if (btnLayout) btnLayout.addEventListener('click', cycleMemoryGraphLayout);
  if (btnCloseFull) btnCloseFull.addEventListener('click', closeFullMemoryGraph);
  if (btnFit) btnFit.addEventListener('click', fitMemoryGraphView);

  if (layoutSelect) layoutSelect.addEventListener('change', handleMemGraphLayoutChange);
  if (clusterSelect) clusterSelect.addEventListener('change', handleMemGraphClusterChange);
  if (gravitySlider) gravitySlider.addEventListener('input', handleMemGraphPhysicsChange);
  if (repulsionSlider) repulsionSlider.addEventListener('input', handleMemGraphPhysicsChange);
  if (linkSlider) linkSlider.addEventListener('input', handleMemGraphPhysicsChange);

  if (fullOverlay) fullOverlay.addEventListener('click', (e) => {
    if (e.target === fullOverlay) closeFullMemoryGraph();
  });
}

// ═══════════════════════════════════════
// 事件绑定
// ═══════════════════════════════════════

function bindEvents() {
  // 发送消息
  dom.btnSend.addEventListener('click', handleSend);
  dom.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // 对话模式切换
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.chatMode = btn.dataset.mode;
      dom.chatInput.placeholder = state.chatMode === 'task'
        ? '输入任务描述，如：分析sales.csv生成报告...'
        : '输入消息或任务描述...';
    });
  });

  // 记忆搜索
  let searchDebounce;
  dom.memorySearch.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(handleMemorySearch, 300);
  });

  // 控制按钮
  dom.btnPause.addEventListener('click', async () => {
    await API.pause();
    addSystemMessage('⏸ 调度器已暂停');
  });

  dom.btnResume.addEventListener('click', async () => {
    await API.resume();
    addSystemMessage('▶ 调度器已恢复');
  });

  // v6.0: 系统自检按钮
  if (dom.btnSelfCheck) {
    dom.btnSelfCheck.addEventListener('click', () => {
      if (window.openSystemSelfCheck) {
        window.openSystemSelfCheck();
      } else {
        alert('系统自检模块加载中，请稍后再试...');
      }
    });
  }

  // 子智能体管理按钮
  if (dom.btnCreateSubagent) {
    dom.btnCreateSubagent.addEventListener('click', openSubAgentModal);
  }
  if (dom.btnRefreshSubagents) {
    dom.btnRefreshSubagents.addEventListener('click', refreshSubAgents);
  }

  // 子智能体创建对话框
  const btnCloseModal = document.getElementById('btn-close-modal');
  const btnCancelSubagent = document.getElementById('btn-cancel-subagent');
  const btnConfirmSubagent = document.getElementById('btn-confirm-subagent');
  const btnCloseDetailModal = document.getElementById('btn-close-detail-modal');

  if (btnCloseModal) btnCloseModal.addEventListener('click', closeSubAgentModal);
  if (btnCancelSubagent) btnCancelSubagent.addEventListener('click', closeSubAgentModal);
  if (btnConfirmSubagent) btnConfirmSubagent.addEventListener('click', createSubAgent);
  if (btnCloseDetailModal) btnCloseDetailModal.addEventListener('click', closeSubAgentDetailModal);

  // 点击遮罩关闭
  const overlay = document.getElementById('subagent-modal');
  const detailOverlay = document.getElementById('subagent-detail-modal');
  const chatOverlay = document.getElementById('subagent-chat-modal');
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSubAgentModal(); });
  if (detailOverlay) detailOverlay.addEventListener('click', (e) => { if (e.target === detailOverlay) closeSubAgentDetailModal(); });
  if (chatOverlay) chatOverlay.addEventListener('click', (e) => { if (e.target === chatOverlay) closeAgentChat(); });

  // v2.7: 子智能体对话面板事件
  const btnCloseChatModal = document.getElementById('btn-close-chat-modal');
  const btnChatNewSession = document.getElementById('btn-chat-new-session');
  const btnChatClearSession = document.getElementById('btn-chat-clear-session');
  const btnSubagentSend = document.getElementById('btn-subagent-send');
  const subagentChatInput = document.getElementById('subagent-chat-input');

  if (btnCloseChatModal) btnCloseChatModal.addEventListener('click', closeAgentChat);
  if (btnChatNewSession) btnChatNewSession.addEventListener('click', createNewSession);
  if (btnChatClearSession) btnChatClearSession.addEventListener('click', clearCurrentSession);
  if (btnSubagentSend) btnSubagentSend.addEventListener('click', sendMessageToAgent);
  if (subagentChatInput) {
    subagentChatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessageToAgent();
      }
    });
  }
}

// ═══════════════════════════════════════
// Agent事件订阅
// ═══════════════════════════════════════

function subscribeAgentEvents() {
  const unsub = [];

  unsub.push(API.on('scheduler:mode_change', ({ from, to }) => {
    dom.sCurrentMode.textContent = to;
    dom.sMode.textContent = to;
    addSystemMessage(`调度模式: ${from} → ${to}`);
  }));

  unsub.push(API.on('scheduler:tick', (tick) => {
    // TICK事件频率较高，只更新计数
    refreshStatus();
  }));

  unsub.push(API.on('consciousness:task_needed', ({ goal }) => {
    addSystemMessage(`💡 意识核建议执行: ${goal}`);
  }));

  unsub.push(API.on('execution:task_completed', ({ taskId }) => {
    addSystemMessage(`✅ 任务完成: ${taskId}`);
    refreshStatus();
  }));

  unsub.push(API.on('execution:dangerous_action', ({ taskId, step }) => {
    addSystemMessage(`⚠️ 危险操作待确认: 任务${taskId} 步骤${step?.action}`);
  }));

  unsub.push(API.on('evolution:skill_extracted', ({ name, category }) => {
    addSystemMessage(`🧬 技能沉淀: "${name}" (${category})`);
    refreshStatus();
  }));

  unsub.push(API.on('evolution:skill_audited', ({ skillId, decision }) => {
    addSystemMessage(`📋 技能审计: #${skillId} → ${decision}`);
  }));

  unsub.push(API.on('social:message_received', (msg) => {
    addSystemMessage(`📩 ${msg.channel}: ${msg.content?.substring(0, 50)}`);
  }));

  state.eventSubscriptions = unsub;
}

// ═══════════════════════════════════════
// 状态刷新
// ═══════════════════════════════════════

async function refreshStatus() {
  if (!API) return;

  try {
    const status = await API.getStatus();
    if (!status) return;
    state.agentStatus = status;

    // 版本
    if (status.version) dom.version.textContent = `v${status.version}`;

    // 指示灯
    updateIndicator(dom.indConsciousness, status.running);
    updateIndicator(dom.indExecution, status.running);
    updateIndicator(dom.indEvolution, status.running);

    // 意识核
    if (status.consciousness) {
      dom.cTicks.textContent = status.consciousness.tickCounter ?? '-';
      dom.cAwakening.textContent = status.consciousness.awakeningRemaining ?? '-';
      dom.cMode.textContent = status.consciousness.awakeningRemaining > 0 ? 'AWAKENING' : 'ACTIVE';

      // v4.0: L1缓存命中率 & 活动状态
      const l1El = document.getElementById('consciousness-l1-hitrate');
      if (l1El && status.consciousness.l1CacheHitRate !== undefined) {
        l1El.textContent = (status.consciousness.l1CacheHitRate * 100).toFixed(1) + '%';
      }
      const activeStateEl = document.getElementById('consciousness-active-state');
      if (activeStateEl && status.consciousness.activeState) {
        activeStateEl.textContent = status.consciousness.activeState;
      }

      // v4.0: TICK 心跳动画触发
      const heartbeat = document.getElementById('tick-heartbeat');
      if (heartbeat && status.consciousness.tickCounter > 0) {
        heartbeat.classList.add('beating');
      }

      // 焦点栈
      if (status.consciousness.focusStack?.length > 0) {
        dom.focusStack.innerHTML = status.consciousness.focusStack
          .map((f, i) => `<div class="focus-item ${i === 0 ? 'current' : ''}">${f.topic || f}</div>`)
          .join('');
      }
    }

    // 执行核
    if (status.execution) {
      dom.eCompleted.textContent = status.execution.completedTasks ?? 0;
      dom.eActive.textContent = status.execution.activeTasks ?? 0;
      dom.eTools.textContent = status.execution.toolsCount ?? 0;
      dom.eTasks.textContent = status.execution.activeTasks ?? 0;

      // v4.0: 完成率 & 并行工具数
      const rateEl = document.getElementById('execution-completion-rate');
      if (rateEl) {
        const total = (status.execution.completedTasks || 0) + (status.execution.activeTasks || 0);
        rateEl.textContent = total > 0 ? ((status.execution.completedTasks || 0) / total * 100).toFixed(1) + '%' : '-';
      }
      const ptEl = document.getElementById('execution-parallel-tools');
      if (ptEl && status.execution.parallelTools !== undefined) {
        ptEl.textContent = status.execution.parallelTools;
      }
    }

    // 进化核
    if (status.evolution) {
      dom.vApproved.textContent = status.evolution.approvedSkills ?? 0;
      dom.vPending.textContent = status.evolution.pendingSkills ?? 0;
      dom.vSkills.textContent = status.evolution.approvedSkills ?? 0;
      if (status.evolution.lastConsolidationAt) {
        const ago = Math.round((Date.now() - status.evolution.lastConsolidationAt) / 60000);
        dom.vConsolidation.textContent = `${ago}分钟前`;
      }
    }

    // 调度器
    if (status.scheduler) {
      dom.sCurrentMode.textContent = status.scheduler.mode || 'IDLE';
      dom.sMode.textContent = status.scheduler.mode || 'IDLE';
      if (status.scheduler.tickInterval) {
        const sec = Math.round(status.scheduler.tickInterval / 1000);
        dom.sTickInterval.textContent = sec >= 60 ? `${Math.round(sec/60)}min` : `${sec}s`;
      }
      dom.sQuota.textContent = `${status.scheduler.consciousnessTicksThisHour ?? 0}/12`;
    }

    // 路由
    if (status.router) {
      dom.rConsciousness.textContent = status.router.consciousnessModel || '-';
      dom.rExecution.textContent = status.router.executionModel || '-';
      dom.rEvolution.textContent = status.router.evolutionModel || '-';
    }

    // 浏览器
    if (status.browser) {
      dom.browserStatus.textContent = status.browser.initialized ? '已启用' : '未初始化';
      dom.browserPage.textContent = status.browser.currentPage || '-';
    }

    // 社交
    if (status.social?.connectors) {
      const channels = Object.entries(status.social.connectors).map(([ch, info]) => {
        const cls = info.connected ? 'connected' : 'disconnected';
        const name = { discord: 'Discord', wechat_clawbot: '微信', feishu: '飞书', wecom: '企微' }[ch] || ch;
        return `<div class="channel-item ${cls}">${name}</div>`;
      }).join('');
      dom.channelList.innerHTML = channels;
    }

    // 记忆
    if (status.memory) {
      const total = status.memory.memories?.reduce((s, m) => s + m.count, 0) || 0;
      dom.footerMemory.textContent = `记忆: ${total}`;
    }

    // 运行状态
    dom.footerStatus.textContent = status.running ? '● 运行中' : '○ 已停止';
    dom.footerStatus.style.color = status.running ? 'var(--accent-green)' : 'var(--text-muted)';

    // 子智能体状态
    if (status.subAgents) {
      const { total, active, safetyStatus } = status.subAgents;
      if (dom.subagentCount) dom.subagentCount.textContent = total || 0;
      if (dom.subagentActiveTotal) dom.subagentActiveTotal.textContent = `${active || 0}/${total || 0}`;
      if (dom.subagentSafety) {
        dom.subagentSafety.textContent = safetyStatus || '正常';
        dom.subagentSafety.style.color = safetyStatus === '告警' ? 'var(--accent-yellow)' :
          safetyStatus === '危险' ? 'var(--accent-red)' : 'var(--accent-green)';
      }
      // 子智能体指示灯
      updateIndicator(dom.indSubagents, active > 0);
    }

    // v3.0: 消息处理器状态
    if (status.messageProcessor) {
      const mp = status.messageProcessor;
      const stateEl = document.getElementById('msgp-state');
      const activeEl = document.getElementById('msgp-active');
      const processedEl = document.getElementById('msgp-processed');
      if (stateEl && mp.activePipelines > 0) stateEl.textContent = '处理中';
      if (activeEl) activeEl.textContent = mp.activePipelines || 0;
      if (processedEl) processedEl.textContent = mp.totalProcessed || 0;
    }

    // v3.0: 记忆网络图状态
    if (status.memoryNetworkGraph) {
      const mg = status.memoryNetworkGraph;
      const nodeCountEl = document.getElementById('memgraph-node-count');
      const statsEl = document.getElementById('memgraph-stats');
      const clustersEl = document.getElementById('memgraph-clusters');
      if (nodeCountEl) nodeCountEl.textContent = mg.currentNodeCount || 0;
      if (statsEl) statsEl.textContent = `${mg.currentNodeCount || 0}/${mg.currentEdgeCount || 0}`;
      if (clustersEl) clustersEl.textContent = mg.clusterCount || 0;
    }
  } catch (error) {
    LOG.error('[蜜糖 TriCore Brain UI] 刷新状态失败:', error);
  }
}

function updateIndicator(element, active) {
  element.className = `indicator ${active ? 'active' : ''}`;
}

// ═══════════════════════════════════════
// 消息处理
// ═══════════════════════════════════════

async function handleSend() {
  const content = dom.chatInput.value.trim();
  if (!content) return;

  // 显示用户消息
  addChatMessage('user', content);
  dom.chatInput.value = '';

  try {
    if (state.chatMode === 'task') {
      // 任务模式
      const result = await API.submitTask(content);
      addChatMessage('agent', `任务已提交: ${result.taskId || '创建中...'}`);
    } else {
      // 对话模式
      const result = await API.sendMessage('ui_user', content);
      addChatMessage('agent', `消息已入队: ${result.messageId || '处理中...'}`);
    }
  } catch (error) {
    addChatMessage('agent', `⚠️ 错误: ${error.message}`);
  }
}

function addChatMessage(role, content) {
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.textContent = content;
  dom.chatMessages.appendChild(msg);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'system-message';
  msg.textContent = text;
  dom.chatMessages.appendChild(msg);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

// ═══════════════════════════════════════
// 记忆搜索
// ═══════════════════════════════════════

async function handleMemorySearch() {
  const query = dom.memorySearch.value.trim();
  if (!query) {
    dom.memoryStream.innerHTML = '';
    return;
  }

  try {
    const memories = await API.searchMemories(query, 10);
    if (!memories || memories.length === 0) {
      dom.memoryStream.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:4px;">无匹配记忆</div>';
      return;
    }

    dom.memoryStream.innerHTML = memories.map(m => `
      <div class="memory-item">
        ${m.content?.substring(0, 100) || '-'}
        <div class="memory-meta">
          ${m.tier || '?'} · ${m.salience?.toFixed(1) || '-'} · ${m.source || '-'}
        </div>
      </div>
    `).join('');
  } catch (error) {
    dom.memoryStream.innerHTML = `<div style="color:var(--accent-red);font-size:11px;">搜索失败: ${error.message}</div>`;
  }
}

// ═══════════════════════════════════════
// 运行时间
// ═══════════════════════════════════════

function updateUptime() {
  const sec = Math.round((Date.now() - state.startTime) / 1000);
  const min = Math.floor(sec / 60);
  const h = Math.floor(min / 60);
  dom.footerUptime.textContent = h > 0
    ? `运行: ${h}h${min % 60}m`
    : min > 0
      ? `运行: ${min}m${sec % 60}s`
      : `运行: ${sec}s`;
}

// ═══════════════════════════════════════
// 子智能体管理
// ═══════════════════════════════════════

let subAgentsCache = [];

async function refreshSubAgents() {
  try {
    const result = await API.getSubAgents();
    subAgentsCache = result?.agents || [];
    renderSubAgentList();
  } catch (error) {
    LOG.error('[蜜糖 TriCore] 刷新子智能体失败:', error);
  }
}

function renderSubAgentList() {
  if (!dom.subagentList) return;

  if (subAgentsCache.length === 0) {
    dom.subagentList.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:4px;">暂无子智能体</div>';
    return;
  }

  dom.subagentList.innerHTML = subAgentsCache.map((agent, idx) => {
    const statusCls = agent.status === 'running' ? 'running' :
      agent.status === 'error' ? 'error' :
      agent.status === 'stopped' ? 'stopped' : 'pending';
    const statusLabel = { running: '运行中', stopped: '已停止', error: '异常', pending: '等待中' }[agent.status] || agent.status;
    const safetyCls = agent.safetyLevel === 'high' || agent.safetyLevel === 'maximum' ? 'safe' : 'warn';
    const canChat = agent.status === 'running';

    return `
      <div class="subagent-item" data-id="${agent.id}">
        <div class="subagent-item-header" onclick="window._viewSubAgentDetail('${agent.id}')">
          <span class="subagent-name">🤖 ${escapeHtml(agent.name || '未命名')}</span>
          <span class="subagent-status ${statusCls}">${statusLabel}</span>
        </div>
        <div class="subagent-item-meta" onclick="window._viewSubAgentDetail('${agent.id}')">
          <span class="subagent-type">${escapeHtml(agent.type || '通用')}</span>
          <span class="subagent-safety ${safetyCls}">🔒 ${escapeHtml(agent.safetyLevel || 'medium')}</span>
        </div>
        ${canChat ? `<div class="subagent-item-actions">
          <button class="btn-mini btn-chat" onclick="event.stopPropagation();window._openAgentChat('${agent.id}','${escapeHtml(agent.name || '未命名')}')">💬 对话</button>
          <button class="btn-mini" onclick="event.stopPropagation();window._toggleSubAgent('${agent.id}','stop')">⏹ 停止</button>
        </div>` : agent.status === 'stopped' ? `<div class="subagent-item-actions">
          <button class="btn-mini" onclick="event.stopPropagation();window._toggleSubAgent('${agent.id}','start')">▶ 启动</button>
        </div>` : ''}
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// 打开创建子智能体对话框
function openSubAgentModal() {
  const modal = document.getElementById('subagent-modal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('subagent-name').focus();
  }
}

// 关闭创建对话框
function closeSubAgentModal() {
  const modal = document.getElementById('subagent-modal');
  if (modal) {
    modal.style.display = 'none';
    // 清空表单
    document.getElementById('subagent-name').value = '';
    document.getElementById('subagent-description').value = '';
    document.getElementById('subagent-type').value = 'assistant';
    document.getElementById('subagent-security').value = 'medium';
    document.getElementById('subagent-quota').value = 'medium';
    document.getElementById('subagent-auto-start').checked = true;
  }
}

// 关闭详情对话框
function closeSubAgentDetailModal() {
  const modal = document.getElementById('subagent-detail-modal');
  if (modal) modal.style.display = 'none';
}

// 创建子智能体
async function createSubAgent() {
  const name = document.getElementById('subagent-name').value.trim();
  const type = document.getElementById('subagent-type').value;
  const description = document.getElementById('subagent-description').value.trim();
  const security = document.getElementById('subagent-security').value;
  const quota = document.getElementById('subagent-quota').value;
  const autoStart = document.getElementById('subagent-auto-start').checked;

  if (!name) {
    alert('请输入子智能体名称');
    return;
  }

  try {
    const result = await API.createSubAgent({ name, type, description, security, quota, autoStart });
    if (result?.success) {
      addSystemMessage(`🤖 子智能体 "${name}" 创建成功 (ID: ${result.agentId})`);
      closeSubAgentModal();
      await refreshSubAgents();
      await refreshStatus();
    } else {
      addSystemMessage(`⚠️ 创建子智能体失败: ${result?.error || '未知错误'}`);
    }
  } catch (error) {
    addSystemMessage(`⚠️ 创建子智能体失败: ${error.message}`);
  }
}

// 查看子智能体详情
async function viewSubAgentDetail(agentId) {
  try {
    const detail = await API.getSubAgentDetail(agentId);
    if (!detail) {
      addSystemMessage('⚠️ 无法获取子智能体详情');
      return;
    }

    const modal = document.getElementById('subagent-detail-modal');
    const title = document.getElementById('subagent-detail-title');
    const body = document.getElementById('subagent-detail-body');
    const footer = document.getElementById('subagent-detail-footer');

    if (!modal) return;

    title.textContent = `🤖 ${detail.name || agentId}`;
    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">ID</span>
          <span class="detail-value">${escapeHtml(detail.id)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">类型</span>
          <span class="detail-value">${escapeHtml(detail.type)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">状态</span>
          <span class="detail-value status-${detail.status}">${detail.status}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">安全等级</span>
          <span class="detail-value">🔒 ${escapeHtml(detail.safetyLevel)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">资源配额</span>
          <span class="detail-value">${escapeHtml(detail.quota)}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">创建时间</span>
          <span class="detail-value">${detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '-'}</span>
        </div>
        <div class="detail-item full-width">
          <span class="detail-label">描述</span>
          <span class="detail-value">${escapeHtml(detail.description || '无描述')}</span>
        </div>
        <div class="detail-item full-width">
          <span class="detail-label">安全报告</span>
          <div class="safety-report">
            <div class="safety-stat">
              <span>违规次数</span>
              <span class="${detail.safetyReport?.violations > 0 ? 'text-warn' : 'text-ok'}">${detail.safetyReport?.violations || 0}</span>
            </div>
            <div class="safety-stat">
              <span>最后活跃</span>
              <span>${detail.safetyReport?.lastActive ? new Date(detail.safetyReport.lastActive).toLocaleString() : '-'}</span>
            </div>
            <div class="safety-stat">
              <span>安全评分</span>
              <span class="${(detail.safetyReport?.score || 100) >= 80 ? 'text-ok' : 'text-warn'}">${detail.safetyReport?.score || 100}/100</span>
            </div>
          </div>
        </div>
      </div>
    `;

    // 操作按钮
    const isRunning = detail.status === 'running';
    footer.innerHTML = `
      <button class="btn-secondary" onclick="closeSubAgentDetailModal()">关闭</button>
      <button class="btn-warning" onclick="window._toggleSubAgent('${agentId}', '${isRunning ? 'stop' : 'start'}')">
        ${isRunning ? '⏹ 停止' : '▶ 启动'}
      </button>
      <button class="btn-danger" onclick="window._deleteSubAgent('${agentId}')">🗑 删除</button>
    `;

    modal.style.display = 'flex';
  } catch (error) {
    addSystemMessage(`⚠️ 获取详情失败: ${error.message}`);
  }
}

// 切换子智能体状态
async function toggleSubAgent(agentId, action) {
  try {
    const result = action === 'stop' ? await API.stopSubAgent(agentId) : await API.startSubAgent(agentId);
    if (result?.success) {
      addSystemMessage(`🤖 子智能体 ${agentId} 已${action === 'stop' ? '停止' : '启动'}`);
      closeSubAgentDetailModal();
      await refreshSubAgents();
      await refreshStatus();
    } else {
      addSystemMessage(`⚠️ 操作失败: ${result?.error || '未知错误'}`);
    }
  } catch (error) {
    addSystemMessage(`⚠️ 操作失败: ${error.message}`);
  }
}

// 删除子智能体
async function deleteSubAgent(agentId) {
  if (!confirm(`确定要删除子智能体 "${agentId}" 吗？此操作不可撤销。`)) return;
  try {
    const result = await API.deleteSubAgent(agentId);
    if (result?.success) {
      addSystemMessage(`🗑 子智能体 ${agentId} 已删除`);
      closeSubAgentDetailModal();
      await refreshSubAgents();
      await refreshStatus();
    } else {
      addSystemMessage(`⚠️ 删除失败: ${result?.error || '未知错误'}`);
    }
  } catch (error) {
    addSystemMessage(`⚠️ 删除失败: ${error.message}`);
  }
}

// ═══════════════════════════════════════
// v2.7: 子智能体独立对话
// ═══════════════════════════════════════

const chatState = {
  activeAgentId: null,
  activeAgentName: null,
  activeSessionId: null,
  sessions: [],
  messages: [],
};

// 打开子智能体对话面板
async function openAgentChat(agentId, agentName) {
  chatState.activeAgentId = agentId;
  chatState.activeAgentName = agentName;

  const modal = document.getElementById('subagent-chat-modal');
  const title = document.getElementById('subagent-chat-title');

  if (!modal) return;

  title.textContent = `💬 ${agentName}`;
  modal.style.display = 'flex';

  // 加载引擎状态
  await refreshChatEngineStatus();

  // 加载会话列表
  await refreshChatSessions();

  // 加载当前会话消息
  if (chatState.activeSessionId) {
    await refreshChatMessages();
  }

  // 聚焦输入框
  setTimeout(() => {
    const input = document.getElementById('subagent-chat-input');
    if (input) input.focus();
  }, 100);
}

// 关闭对话面板
function closeAgentChat() {
  const modal = document.getElementById('subagent-chat-modal');
  if (modal) {
    modal.style.display = 'none';
  }
  chatState.activeAgentId = null;
  chatState.activeSessionId = null;
  chatState.sessions = [];
  chatState.messages = [];
}

// 刷新引擎状态
async function refreshChatEngineStatus() {
  if (!chatState.activeAgentId) return;

  try {
    const status = await API.getSubAgentEngineStatus(chatState.activeAgentId);
    const indicator = document.getElementById('engine-state-indicator');
    const info = document.getElementById('engine-info');

    if (status) {
      const stateColors = {
        idle: 'var(--accent-green)',
        thinking: 'var(--accent-yellow)',
        executing: 'var(--accent-cyan)',
        responding: 'var(--accent-blue)',
        error: 'var(--accent-red)',
      };
      const stateLabels = {
        idle: '就绪',
        thinking: '思考中...',
        executing: '执行中...',
        responding: '回复中...',
        error: '错误',
      };

      indicator.textContent = `● ${stateLabels[status.state] || status.state}`;
      indicator.style.color = stateColors[status.state] || 'var(--text-muted)';
      info.textContent = `会话: ${status.sessions || 0} | 消息: ${status.stats?.messagesProcessed || 0}`;
    } else {
      indicator.textContent = '● 引擎未启动';
      indicator.style.color = 'var(--text-muted)';
      info.textContent = '';
    }
  } catch (error) {
    LOG.error('[蜜糖 TriCore] 获取引擎状态失败:', error);
  }
}

// 刷新会话列表
async function refreshChatSessions() {
  if (!chatState.activeAgentId) return;

  try {
    const sessions = await API.listSubAgentSessions(chatState.activeAgentId);
    chatState.sessions = sessions || [];

    if (chatState.sessions.length > 0 && !chatState.activeSessionId) {
      const activeSession = chatState.sessions.find(s => s.isActive);
      chatState.activeSessionId = activeSession ? activeSession.id : chatState.sessions[0].id;
    }

    renderSessionList();
  } catch (error) {
    LOG.error('[蜜糖 TriCore] 获取会话列表失败:', error);
  }
}

// 渲染会话列表
function renderSessionList() {
  const container = document.getElementById('session-list');
  if (!container) return;

  if (chatState.sessions.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px;">暂无会话</div>';
    return;
  }

  container.innerHTML = chatState.sessions.map(s => {
    const isActive = s.id === chatState.activeSessionId;
    const date = s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '';
    return `
      <div class="session-item ${isActive ? 'active' : ''}" onclick="window._switchSession('${s.id}')">
        <div class="session-item-name">${escapeHtml(s.name || '未命名')}</div>
        <div class="session-item-meta">
          <span>${s.messageCount || 0} 条消息</span>
          <span>${date}</span>
        </div>
      </div>
    `;
  }).join('');
}

// 切换会话
async function switchSession(sessionId) {
  chatState.activeSessionId = sessionId;

  try {
    await API.switchSubAgentSession(chatState.activeAgentId, sessionId);
  } catch (e) {}

  renderSessionList();
  await refreshChatMessages();
}

// 新建会话
async function createNewSession() {
  if (!chatState.activeAgentId) return;

  try {
    const result = await API.createSubAgentSession(chatState.activeAgentId, { name: `会话 ${Date.now() % 100000}` });
    if (result?.success) {
      chatState.activeSessionId = result.sessionId;
      await refreshChatSessions();
      await refreshChatMessages();
      addSystemMessage(`💬 新会话已创建: ${result.session?.name || result.sessionId}`);
    }
  } catch (error) {
    addSystemMessage(`⚠️ 创建会话失败: ${error.message}`);
  }
}

// 清空当前会话
async function clearCurrentSession() {
  if (!chatState.activeAgentId || !chatState.activeSessionId) return;
  if (!confirm('确定要清空当前会话的所有消息吗？')) return;

  try {
    const result = await API.clearSubAgentSession(chatState.activeAgentId, chatState.activeSessionId);
    if (result?.success) {
      await refreshChatMessages();
      addSystemMessage('🗑 会话已清空');
    }
  } catch (error) {
    addSystemMessage(`⚠️ 清空失败: ${error.message}`);
  }
}

// 刷新消息列表
async function refreshChatMessages() {
  if (!chatState.activeAgentId || !chatState.activeSessionId) return;

  try {
    const session = await API.getSubAgentSession(chatState.activeAgentId, chatState.activeSessionId);
    if (session?.messages) {
      chatState.messages = session.messages;
      renderChatMessages();
    }
  } catch (error) {
    LOG.error('[蜜糖 TriCore] 获取消息失败:', error);
  }
}

// 渲染消息列表
function renderChatMessages() {
  const container = document.getElementById('subagent-messages');
  if (!container) return;

  if (chatState.messages.length === 0) {
    container.innerHTML = '<div class="chat-empty">开始与子智能体对话吧 💬</div>';
    return;
  }

  container.innerHTML = chatState.messages
    .filter(m => m.role !== 'system' || m.isSummary)
    .map(m => {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
      const roleClass = m.role === 'user' ? 'msg-user' :
        m.role === 'assistant' ? 'msg-assistant' :
        m.role === 'error' ? 'msg-error' : 'msg-system';
      const avatar = m.role === 'user' ? '👤' :
        m.role === 'assistant' ? '🤖' :
        m.role === 'error' ? '⚠️' : '📋';

      const content = m.role === 'assistant' && m.metadata
        ? `${m.content}\n\n<div class="msg-metadata">⏱ ${m.metadata.responseTime || 0}ms | 🧠 ${m.metadata.reasoningMode || 'direct'}${m.metadata.toolCallsUsed?.length ? ' | 🔧 ' + m.metadata.toolCallsUsed.join(', ') : ''}</div>`
        : m.content;

      return `
        <div class="chat-message ${roleClass}">
          <div class="msg-header">
            <span class="msg-avatar">${avatar}</span>
            <span class="msg-time">${time}</span>
          </div>
          <div class="msg-content">${escapeHtml(content).replace(/\n/g, '<br>')}</div>
        </div>
      `;
    }).join('');

  // 滚动到底部
  container.scrollTop = container.scrollHeight;
}

// 发送消息到子智能体
async function sendMessageToAgent() {
  const input = document.getElementById('subagent-chat-input');
  if (!input || !chatState.activeAgentId) return;

  const content = input.value.trim();
  if (!content) return;

  // 显示用户消息
  input.value = '';
  input.disabled = true;

  // 添加到本地消息列表
  const userMsg = {
    role: 'user',
    content: content,
    timestamp: Date.now(),
  };
  chatState.messages.push(userMsg);
  renderChatMessages();

  // 显示思考中
  const indicator = document.getElementById('engine-state-indicator');
  if (indicator) {
    indicator.textContent = '● 思考中...';
    indicator.style.color = 'var(--accent-yellow)';
  }

  try {
    const result = await API.sendMessageToSubAgent(chatState.activeAgentId, content, chatState.activeSessionId);

    if (result?.success) {
      // 刷新消息
      await refreshChatMessages();
      await refreshChatEngineStatus();
      await refreshChatSessions();
    } else {
      const errMsg = {
        role: 'error',
        content: `发送失败: ${result?.error || '未知错误'}`,
        timestamp: Date.now(),
      };
      chatState.messages.push(errMsg);
      renderChatMessages();
    }
  } catch (error) {
    const errMsg = {
      role: 'error',
      content: `发送失败: ${error.message}`,
      timestamp: Date.now(),
    };
    chatState.messages.push(errMsg);
    renderChatMessages();
  } finally {
    input.disabled = false;
    input.focus();
    if (indicator) {
      indicator.textContent = '● 就绪';
      indicator.style.color = 'var(--accent-green)';
    }
  }
}

// 暴露到全局作用域（供HTML onclick使用）
window._viewSubAgentDetail = viewSubAgentDetail;
window._toggleSubAgent = toggleSubAgent;
window._deleteSubAgent = deleteSubAgent;
window._openAgentChat = openAgentChat;
window._switchSession = switchSession;

// ═══════════════════════════════════════
// v2.9: 技能管理
// ═══════════════════════════════════════

let skillSelectedAgentId = null;
let skillSelectedSkillId = null;

async function openSkillManager() {
  const modal = document.getElementById('skill-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  skillSelectedAgentId = null;
  skillSelectedSkillId = null;
  await refreshSkillAgentList();
}

async function closeSkillManager() {
  const modal = document.getElementById('skill-modal');
  if (modal) modal.style.display = 'none';
}

async function refreshSkillAgentList() {
  const listEl = document.getElementById('skill-agent-list');
  if (!listEl) return;

  try {
    const agents = await API.listSubAgents();
    if (!agents || agents.length === 0) {
      listEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;">暂无子智能体</div>';
      return;
    }

    listEl.innerHTML = agents.map(a => `
      <div class="session-item ${a.id === skillSelectedAgentId ? 'active' : ''}"
           onclick="window._selectSkillAgent('${a.id}')"
           style="cursor:pointer;">
        <div class="session-name">${a.displayName || a.name}</div>
        <div class="session-meta">${a.type} | ${a.status}</div>
      </div>
    `).join('');
  } catch (e) {
    LOG.error('刷新技能代理列表失败:', e);
  }
}

async function selectSkillAgent(agentId) {
  skillSelectedAgentId = agentId;
  skillSelectedSkillId = null;

  // 更新UI
  document.getElementById('skill-agent-name').textContent = '加载中...';
  document.getElementById('skill-count-badge').textContent = '';

  // 刷新代理列表高亮
  const items = document.querySelectorAll('#skill-agent-list .session-item');
  items.forEach(item => {
    item.classList.toggle('active', item.textContent.includes(agentId));
  });

  await refreshSkillList(agentId);
  document.getElementById('skill-action-area').style.display = 'flex';
}

async function refreshSkillList(agentId) {
  const listArea = document.getElementById('skill-list-area');
  if (!listArea) return;

  try {
    const skills = await API.listAgentSkills(agentId);
    const stats = await API.getAgentSkillStats(agentId);

    // 更新顶部
    const agent = (await API.listSubAgents()).find(a => a.id === agentId);
    document.getElementById('skill-agent-name').textContent =
      `技能管理: ${agent?.displayName || agent?.name || agentId}`;
    document.getElementById('skill-count-badge').textContent =
      `${stats.total || 0} 个技能 | ${stats.enabled || 0} 已启用`;

    if (!skills || skills.length === 0) {
      listArea.innerHTML = '<div class="chat-empty">该子智能体暂无已安装技能<br>点击上方按钮安装技能</div>';
      return;
    }

    listArea.innerHTML = skills.map(s => `
      <div class="skill-card ${s.id === skillSelectedSkillId ? 'selected' : ''}"
           onclick="window._selectSkill('${s.id}')">
        <div class="skill-card-info">
          <div class="skill-card-name">${s.displayName || s.name}</div>
          <div class="skill-card-desc">${s.description || '无描述'}</div>
          <div class="skill-card-meta">
            <span class="skill-badge category">${s.category}</span>
            <span class="skill-badge version">v${s.version}</span>
            <span class="skill-badge ${s.enabled ? 'enabled' : 'disabled'}">
              ${s.enabled ? '已启用' : '已禁用'}
            </span>
            ${s.useCount > 0 ? `<span>使用 ${s.useCount} 次</span>` : ''}
          </div>
        </div>
        <div class="skill-card-actions">
          <button class="btn-mini" onclick="event.stopPropagation();window._toggleSkillEnable('${s.id}', ${!s.enabled})">
            ${s.enabled ? '禁用' : '启用'}
          </button>
          <button class="btn-mini btn-success" onclick="event.stopPropagation();window._bindSkill('${s.id}')">
            固化
          </button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    LOG.error('刷新技能列表失败:', e);
    listArea.innerHTML = '<div class="chat-empty">加载技能失败</div>';
  }
}

function selectSkill(skillId) {
  skillSelectedSkillId = skillId;
  const cards = document.querySelectorAll('.skill-card');
  cards.forEach(c => c.classList.toggle('selected', c.textContent.includes(skillId)));
}

async function toggleSkillEnable(skillId, enabled) {
  if (!skillSelectedAgentId) return;
  try {
    const result = await API.toggleAgentSkill(skillSelectedAgentId, skillId, enabled);
    if (result.success) {
      await refreshSkillList(skillSelectedAgentId);
    }
  } catch (e) {
    LOG.error('切换技能状态失败:', e);
  }
}

async function bindSkill(skillId) {
  if (!skillSelectedAgentId) return;
  try {
    const result = await API.bindSkillToMemory(skillSelectedAgentId, skillId);
    if (result.success) {
      addSystemMessage(`🔗 技能已固化到记忆: ${result.name}`);
      await refreshSkillList(skillSelectedAgentId);
    } else {
      addSystemMessage(`❌ 固化失败: ${result.error}`);
    }
  } catch (e) {
    LOG.error('固化技能失败:', e);
  }
}

async function lockSelectedSkill() {
  if (!skillSelectedAgentId || !skillSelectedSkillId) {
    alert('请先选择一个技能');
    return;
  }
  try {
    const result = await API.lockSkillAsCore(skillSelectedAgentId, skillSelectedSkillId);
    if (result.success) {
      addSystemMessage(`🔒 技能已锁定为核心记忆: ${result.name}`);
      await refreshSkillList(skillSelectedAgentId);
    } else {
      addSystemMessage(`❌ 锁定失败: ${result.error}`);
    }
  } catch (e) {
    LOG.error('锁定技能失败:', e);
  }
}

async function uninstallSelectedSkill() {
  if (!skillSelectedAgentId || !skillSelectedSkillId) {
    alert('请先选择一个技能');
    return;
  }
  if (!confirm('确定要卸载该技能吗？此操作将从子智能体中移除该技能。')) return;

  try {
    const result = await API.uninstallAgentSkill(skillSelectedAgentId, skillSelectedSkillId);
    if (result.success) {
      addSystemMessage(`🗑 技能已卸载: ${result.name}`);
      skillSelectedSkillId = null;
      await refreshSkillList(skillSelectedAgentId);
    } else {
      addSystemMessage(`❌ 卸载失败: ${result.error}`);
    }
  } catch (e) {
    LOG.error('卸载技能失败:', e);
  }
}

async function exportSkills() {
  if (!skillSelectedAgentId) {
    alert('请先选择一个子智能体');
    return;
  }
  try {
    const data = await API.exportAgentSkillMemory(skillSelectedAgentId);
    if (data) {
      const json = JSON.stringify(data, null, 2);
      // 复制到剪贴板
      await navigator.clipboard.writeText(json);
      addSystemMessage(`📤 已导出 ${data.skills?.length || 0} 个技能到剪贴板`);
    } else {
      addSystemMessage('❌ 导出失败');
    }
  } catch (e) {
    LOG.error('导出失败:', e);
  }
}

function openSkillContentInstaller() {
  const modal = document.getElementById('skill-content-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  // 填充子智能体选择
  const select = document.getElementById('skill-content-agent-select');
  if (select) {
    API.listSubAgents().then(agents => {
      select.innerHTML = '<option value="">请选择目标子智能体...</option>' +
        (agents || []).map(a => `<option value="${a.id}">${a.displayName || a.name} (${a.type})</option>`).join('');
      if (skillSelectedAgentId) select.value = skillSelectedAgentId;
    });
  }
}

function closeSkillContentInstaller() {
  const modal = document.getElementById('skill-content-modal');
  if (modal) modal.style.display = 'none';
}

async function confirmSkillContentInstall() {
  const agentId = document.getElementById('skill-content-agent-select')?.value;
  const content = document.getElementById('skill-content-editor')?.value;
  const autoApprove = document.getElementById('skill-content-auto-approve')?.checked;

  if (!agentId || !content) {
    alert('请选择目标子智能体并输入技能内容');
    return;
  }

  try {
    const result = await API.installSkillFromContent(agentId, content, { autoApprove });
    if (result.success) {
      addSystemMessage(`✅ 技能安装成功: "${result.name}" v${result.version}`);
      closeSkillContentInstaller();
      if (skillSelectedAgentId === agentId) {
        await refreshSkillList(agentId);
      }
    } else {
      if (result.requireApproval) {
        addSystemMessage(`⚠️ 技能安全警告: ${result.error} - 请手动批准后安装`);
      } else {
        addSystemMessage(`❌ 安装失败: ${result.error}`);
      }
    }
  } catch (e) {
    LOG.error('安装技能失败:', e);
  }
}

// 安装文件 - 使用 Electron dialog
async function installSkillFromFile() {
  if (!skillSelectedAgentId) {
    alert('请先在左侧选择目标子智能体');
    return;
  }

  // 使用 input 元素选择文件
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.skill,.skill.md,.md,.zip,.tar.gz,.tgz';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const filePath = file.path; // Electron 提供 path 属性
      if (filePath) {
        const result = await API.installSkillFromFile(skillSelectedAgentId, filePath, { autoApprove: true });
        if (result.success) {
          addSystemMessage(`✅ 技能文件安装成功: "${result.name}" v${result.version}`);
          await refreshSkillList(skillSelectedAgentId);
        } else {
          addSystemMessage(`❌ 安装失败: ${result.error}`);
        }
      } else {
        // 回退：读取内容
        const content = await file.text();
        const result = await API.installSkillFromContent(skillSelectedAgentId, content, { autoApprove: true });
        if (result.success) {
          addSystemMessage(`✅ 技能安装成功: "${result.name}" v${result.version}`);
          await refreshSkillList(skillSelectedAgentId);
        } else {
          addSystemMessage(`❌ 安装失败: ${result.error}`);
        }
      }
    } catch (e) {
      LOG.error('文件安装失败:', e);
      addSystemMessage(`❌ 文件安装错误: ${e.message}`);
    }
  };
  input.click();
}

async function openMemoryViewer() {
  if (!skillSelectedAgentId) {
    alert('请先选择一个子智能体');
    return;
  }

  const modal = document.getElementById('memory-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  const content = document.getElementById('memory-content');
  try {
    const stats = await API.getAgentMemoryStats(skillSelectedAgentId);
    const boundSkills = await API.getBoundSkills(skillSelectedAgentId);

    let html = '<div class="memory-stat-card"><h4 style="color:var(--accent-cyan);margin-bottom:10px;">记忆统计</h4>';
    html += `<div class="memory-stat-row"><span class="memory-stat-label">总记忆数</span><span class="memory-stat-value">${stats.total || 0}</span></div>`;
    html += `<div class="memory-stat-row"><span class="memory-stat-label">固化技能数</span><span class="memory-stat-value">${stats.skillCount || 0}</span></div>`;
    html += `<div class="memory-stat-row"><span class="memory-stat-label">技能使用总次数</span><span class="memory-stat-value">${stats.totalSkillUses || 0}</span></div>`;
    html += `<div class="memory-stat-row"><span class="memory-stat-label">执行轨迹数</span><span class="memory-stat-value">${stats.executionTraces || 0}</span></div>`;

    if (stats.byTier) {
      for (const [tier, data] of Object.entries(stats.byTier)) {
        html += `<div class="memory-stat-row"><span class="memory-stat-label">${tier}层</span><span class="memory-stat-value">${data.count} 条 (salience: ${data.avgSalience})</span></div>`;
      }
    }
    html += '</div>';

    if (boundSkills && boundSkills.length > 0) {
      html += '<div class="memory-stat-card"><h4 style="color:var(--accent-cyan);margin-bottom:10px;">固化技能</h4>';
      for (const skill of boundSkills) {
        html += `<div class="memory-item">
          <div class="memory-item-content">🧩 <strong>${skill.name}</strong> (v${skill.version}) - ${skill.category}</div>
          <div class="memory-item-meta">使用 ${skill.use_count} 次 | 层级: ${skill.tier}</div>
        </div>`;
      }
      html += '</div>';
    }

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = '<div class="chat-empty">加载记忆数据失败</div>';
  }
}

function closeMemoryViewer() {
  const modal = document.getElementById('memory-modal');
  if (modal) modal.style.display = 'none';
}

// 暴露到全局
window._selectSkillAgent = selectSkillAgent;
window._selectSkill = selectSkill;
window._toggleSkillEnable = toggleSkillEnable;
window._bindSkill = bindSkill;
window._openSkillManager = openSkillManager;
window._closeSkillManager = closeSkillManager;
window._openSkillContentInstaller = openSkillContentInstaller;
window._closeSkillContentInstaller = closeSkillContentInstaller;
window._confirmSkillContentInstall = confirmSkillContentInstall;
window._installSkillFromFile = installSkillFromFile;
window._lockSelectedSkill = lockSelectedSkill;
window._uninstallSelectedSkill = uninstallSelectedSkill;
window._exportSkills = exportSkills;
window._openMemoryViewer = openMemoryViewer;
window._closeMemoryViewer = closeMemoryViewer;

// ═══════════════════════════════════════
// v3.0: 用户消息处理器面板
// ═══════════════════════════════════════

const msgpState = {
  activePipelines: [],
  stats: null,
  refreshTimer: null,
};

async function refreshMessageProcessor() {
  try {
    const stats = await API.getMessageProcessorStats();
    if (!stats) return;
    msgpState.stats = stats;

    // 更新统计
    const stateEl = document.getElementById('msgp-state');
    const activeEl = document.getElementById('msgp-active');
    const processedEl = document.getElementById('msgp-processed');
    const quantumEl = document.getElementById('msgp-quantum');
    const interruptedEl = document.getElementById('msgp-interrupted');
    const avgTimeEl = document.getElementById('msgp-avg-time');

    if (stateEl) {
      const label = stats.activePipelines > 0 ? '处理中' : '待机';
      stateEl.textContent = label;
      stateEl.className = stats.activePipelines > 0 ? 'badge pulse-badge' : 'badge';
    }
    if (activeEl) activeEl.textContent = stats.activePipelines || 0;
    if (processedEl) processedEl.textContent = stats.totalProcessed || 0;
    if (interruptedEl) interruptedEl.textContent = stats.totalInterrupted || 0;
    if (avgTimeEl) avgTimeEl.textContent = stats.avgProcessingMs ? Math.round(stats.avgProcessingMs) + 'ms' : '-';

    // 量子态显示
    const ent = stats.byQuantumState?.entangled || 0;
    const sup = stats.byQuantumState?.superposed || 0;
    const col = stats.byQuantumState?.collapsed || 0;
    const det = stats.byQuantumState?.determined || 0;
    if (quantumEl) {
      if (ent > 0) quantumEl.innerHTML = '🔮 纠缠 (' + ent + ')';
      else if (sup > 0) quantumEl.innerHTML = '⚡ 叠加 (' + sup + ')';
      else if (col > 0) quantumEl.innerHTML = '✦ 塌缩 (' + col + ')';
      else if (det > 0) quantumEl.innerHTML = '◉ 确定 (' + det + ')';
      else quantumEl.innerHTML = '○ 确定';
    }

    // 刷新活跃管道列表
    await refreshPipelineMini();

    // 更新意图分布（如果有）
    const intentBar = document.getElementById('msgp-intent-bar');
    if (intentBar && stats.byIntent) {
      const intents = Object.entries(stats.byIntent).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const maxVal = intents.length > 0 ? intents[0][1] : 1;
      intentBar.innerHTML = intents.map(([intent, count]) => `
        <div class="intent-mini-bar" title="${intent}: ${count}">
          <span class="intent-mini-label">${intent}</span>
          <div class="intent-mini-track"><div class="intent-mini-fill intent-${intent}" style="width:${(count/maxVal*100).toFixed(0)}%"></div></div>
          <span class="intent-mini-count">${count}</span>
        </div>
      `).join('');
    }
  } catch (e) {
    LOG.error('[蜜糖 TriCore] 刷新消息处理器失败:', e);
  }
}

async function refreshPipelineMini() {
  const container = document.getElementById('msgp-pipeline-mini');
  if (!container) return;

  try {
    const pipelines = await API.getActivePipelines();
    msgpState.activePipelines = pipelines || [];

    if (!pipelines || pipelines.length === 0) {
      container.innerHTML = '<div style="font-size:10px;color:var(--text-muted);padding:4px;">无活跃消息管道</div>';
      return;
    }

    const stateLabels = {
      receiving: '接收', analyzing: '分析', routing: '路由',
      processing: '处理', responding: '响应',
    };
    const quantumIcons = {
      determined: '<span class="quantum-dot determined"></span>',
      superposed: '<span class="quantum-dot superposed"></span>',
      entangled: '<span class="quantum-dot entangled"></span>',
      collapsed: '<span class="quantum-dot collapsed"></span>',
    };

    container.innerHTML = pipelines.slice(0, 5).map(p => `
      <div class="msgp-pipeline-item state-${p.state || 'receiving'}">
        <span>${p.content?.substring(0, 20) || '-'}</span>
        <span>${quantumIcons[p.quantumState] || ''} ${stateLabels[p.state] || p.state}</span>
      </div>
    `).join('');
  } catch (e) {
    LOG.error('[蜜糖 TriCore] 刷新管道列表失败:', e);
  }
}

async function openMessagePipelineDetail() {
  const modal = document.getElementById('msgp-detail-modal');
  const body = document.getElementById('msgp-detail-body');
  if (!modal || !body) return;

  modal.style.display = 'flex';

  try {
    const summary = await API.getRecentMessageSummary(30);
    if (!summary || summary.length === 0) {
      body.innerHTML = '<div class="chat-empty">暂无消息管道记录</div>';
      return;
    }

    const stateLabels = {
      receiving: '接收中', analyzing: '分析中', routing: '路由中',
      processing: '处理中', responding: '响应中', complete: '已完成', interrupted: '已中断',
    };

    body.innerHTML = `
      <table class="msgp-detail-table">
        <thead><tr>
          <th>来源</th><th>内容</th><th>意图</th><th>状态</th><th>量子态</th>
        </tr></thead>
        <tbody>
          ${summary.map(s => `
            <tr>
              <td>${escapeHtml(s.from || '-')}</td>
              <td>${escapeHtml((s.content || '').substring(0, 40))}</td>
              <td><span class="intent-badge ${s.pipeline?.analysis?.intent || 'general'}">${s.pipeline?.analysis?.intent || '通用'}</span></td>
              <td>${stateLabels[s.state] || s.state}</td>
              <td>${s.pipeline?.quantumState || '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    body.innerHTML = `<div class="chat-empty">加载失败: ${e.message}</div>`;
  }
}

function closeMessagePipelineDetail() {
  const modal = document.getElementById('msgp-detail-modal');
  if (modal) modal.style.display = 'none';
}

async function openMessageDAGView() {
  const modal = document.getElementById('msgp-dag-modal');
  if (!modal) return;

  modal.style.display = 'flex';

  try {
    const dagData = await API.getMessageDAGData(50);
    const canvas = document.getElementById('msgp-dag-canvas');
    if (!canvas) return;

    // 调整canvas大小
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    renderDAG(canvas, dagData);
  } catch (e) {
    LOG.error('[蜜糖 TriCore] 加载DAG数据失败:', e);
  }
}

function closeMessageDAGView() {
  const modal = document.getElementById('msgp-dag-modal');
  if (modal) modal.style.display = 'none';
}

// DAG 渲染 (Canvas)
function renderDAG(canvas, dagData) {
  const ctx = canvas.getContext('2d');
  const { nodes, edges } = dagData;
  if (!nodes || nodes.length === 0) {
    ctx.fillStyle = '#555580';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无消息溯源数据', canvas.width / 2, canvas.height / 2);
    return;
  }

  // 简单分层布局
  const layers = {};
  for (const node of nodes) {
    const layer = node.priority >= 100 ? 0 : node.priority >= 50 ? 1 : 2;
    if (!layers[layer]) layers[layer] = [];
    layers[layer].push(node);
  }

  const layerKeys = Object.keys(layers).sort((a, b) => a - b);
  const nodePositions = {};

  for (const [idx, layerKey] of layerKeys.entries()) {
    const layerNodes = layers[layerKey];
    const x = (idx + 1) / (layerKeys.length + 1) * canvas.width;
    const spacing = canvas.height / (layerNodes.length + 1);

    for (const [ni, node] of layerNodes.entries()) {
      const y = (ni + 1) * spacing;
      nodePositions[node.id] = { x, y, node };
    }
  }

  // 画边
  ctx.strokeStyle = 'rgba(68, 136, 255, 0.3)';
  ctx.lineWidth = 1;
  for (const edge of edges) {
    const from = nodePositions[edge.from];
    const to = nodePositions[edge.to];
    if (from && to) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
  }

  // 画节点
  for (const [, pos] of Object.entries(nodePositions)) {
    const r = pos.node.priority >= 100 ? 8 : pos.node.priority >= 50 ? 6 : 4;
    const stateColors = {
      receiving: '#44ddff', analyzing: '#ffcc44', routing: '#4488ff',
      processing: '#aa66ff', responding: '#44dd88', complete: '#44dd88', interrupted: '#ff4466',
    };
    ctx.fillStyle = stateColors[pos.node.state] || '#8888bb';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();

    // 发光效果
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 标签
    ctx.fillStyle = '#e0e0ff';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(pos.node.content?.substring(0, 15) || '-', pos.x, pos.y - r - 6);
  }
}

// ═══════════════════════════════════════
// v3.0: 记忆网络图面板
// ═══════════════════════════════════════

const memGraphState = {
  graphData: null,
  layoutMode: 'force',
  clusterMode: 'hybrid',
  selectedNode: null,
  refreshTimer: null,
  miniAnimFrame: null,
  fullAnimFrame: null,
};

async function refreshMemoryGraphPanel() {
  try {
    const graphData = await API.getMemoryGraphData();
    if (!graphData) return;
    memGraphState.graphData = graphData;

    // 更新统计
    const nodeCountEl = document.getElementById('memgraph-node-count');
    const statsEl = document.getElementById('memgraph-stats');
    const clustersEl = document.getElementById('memgraph-clusters');
    const pulsarsEl = document.getElementById('memgraph-pulsars');
    const densityEl = document.getElementById('memgraph-density');
    const avgDegreeEl = document.getElementById('memgraph-avg-degree');
    const hotCountEl = document.getElementById('memgraph-hot-count');
    const skillCountEl = document.getElementById('memgraph-skill-count');

    if (nodeCountEl) nodeCountEl.textContent = graphData.nodes?.length || 0;
    if (statsEl) statsEl.textContent = `${graphData.nodes?.length || 0}/${graphData.edges?.length || 0}`;
    if (clustersEl) clustersEl.textContent = graphData.clusters?.length || 0;
    if (pulsarsEl) pulsarsEl.textContent = graphData.pulsars?.length || 0;

    // 图密度
    const n = graphData.nodes?.length || 0;
    const e = graphData.edges?.length || 0;
    const maxEdges = n * (n - 1) / 2;
    if (densityEl) densityEl.textContent = maxEdges > 0 ? (e / maxEdges).toFixed(4) : '0.00';
    if (avgDegreeEl) avgDegreeEl.textContent = n > 0 ? (e * 2 / n).toFixed(1) : '0.0';

    // 按类型统计
    if (graphData.nodes) {
      const typeCounts = {};
      for (const node of graphData.nodes) {
        typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
      }
      if (hotCountEl) hotCountEl.textContent = typeCounts.hot || 0;
      if (skillCountEl) skillCountEl.textContent = typeCounts.skill || 0;
    }

    // 渲染迷你Canvas
    renderMiniMemoryGraph();

    // 如果全屏视图打开，也刷新
    const fullModal = document.getElementById('memgraph-full-modal');
    if (fullModal && fullModal.style.display === 'flex') {
      renderFullMemoryGraph();
    }

    // 隐藏overlay
    const overlay = document.getElementById('memgraph-overlay-text');
    if (overlay && graphData.nodes?.length > 0) {
      overlay.style.display = 'none';
    }
  } catch (e) {
    LOG.error('[蜜糖 TriCore] 刷新记忆网络图失败:', e);
  }
}

function renderMiniMemoryGraph() {
  const canvas = document.getElementById('memgraph-mini-canvas');
  if (!canvas || !memGraphState.graphData) return;

  const ctx = canvas.getContext('2d');
  const { nodes, edges, pulsars } = memGraphState.graphData;
  const w = canvas.width;
  const h = canvas.height;

  // 清空
  ctx.clearRect(0, 0, w, h);

  if (!nodes || nodes.length === 0) return;

  // 简单力导向布局
  const positions = {};
  const centerX = w / 2;
  const centerY = h / 2;

  // 按层级分布
  const tierGroups = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  for (const node of nodes) {
    const tier = node.tier ?? 2;
    if (!tierGroups[tier]) tierGroups[tier] = [];
    tierGroups[tier].push(node);
  }

  const tierYs = { 0: h * 0.15, 1: h * 0.3, 2: h * 0.5, 3: h * 0.7, 4: h * 0.85 };

  for (const [tier, tierNodes] of Object.entries(tierGroups)) {
    const y = tierYs[tier] || centerY;
    const spacing = w / (tierNodes.length + 1);
    for (const [idx, node] of tierNodes.entries()) {
      positions[node.id] = {
        x: (idx + 1) * spacing,
        y: y + (Math.random() - 0.5) * 20,
        node,
      };
    }
  }

  // 画边
  ctx.strokeStyle = 'rgba(68, 136, 255, 0.15)';
  ctx.lineWidth = 0.5;
  for (const edge of (edges || [])) {
    const from = positions[edge.source];
    const to = positions[edge.target];
    if (from && to) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
  }

  // 画节点
  for (const [, pos] of Object.entries(positions)) {
    const r = Math.max(2, Math.min(5, pos.node.radius * 0.5));
    ctx.fillStyle = pos.node.color || '#8888bb';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();

    // 脉冲星发光
    if (pos.node.isPulsar) {
      ctx.shadowColor = '#cc44ff';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

async function openFullMemoryGraph() {
  const modal = document.getElementById('memgraph-full-modal');
  if (!modal) return;

  modal.style.display = 'flex';

  // 初始化控件
  const layoutSelect = document.getElementById('memgraph-layout-select');
  const clusterSelect = document.getElementById('memgraph-cluster-select');
  if (layoutSelect) layoutSelect.value = memGraphState.layoutMode;
  if (clusterSelect) clusterSelect.value = memGraphState.clusterMode;

  // 物理参数滑块
  const gravitySlider = document.getElementById('memgraph-gravity-slider');
  const repulsionSlider = document.getElementById('memgraph-repulsion-slider');
  const linkSlider = document.getElementById('memgraph-link-slider');
  if (gravitySlider) gravitySlider.value = memGraphState.graphData?.physics?.gravity || 1.0;
  if (repulsionSlider) repulsionSlider.value = memGraphState.graphData?.physics?.repulsion || 2.0;
  if (linkSlider) linkSlider.value = memGraphState.graphData?.physics?.linkStrength || 0.5;

  // 刷新数据
  await refreshMemoryGraphPanel();

  // 延迟渲染全屏Canvas
  setTimeout(() => renderFullMemoryGraph(), 100);
}

function closeFullMemoryGraph() {
  const modal = document.getElementById('memgraph-full-modal');
  if (modal) modal.style.display = 'none';
  if (memGraphState.fullAnimFrame) {
    cancelAnimationFrame(memGraphState.fullAnimFrame);
    memGraphState.fullAnimFrame = null;
  }
}

function renderFullMemoryGraph() {
  const canvas = document.getElementById('memgraph-full-canvas');
  if (!canvas || !memGraphState.graphData) return;

  const container = canvas.parentElement;
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;

  const ctx = canvas.getContext('2d');
  const { nodes, edges, pulsars, clusters } = memGraphState.graphData;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // 背景网格
  ctx.strokeStyle = 'rgba(42, 42, 90, 0.3)';
  ctx.lineWidth = 0.5;
  const gridSize = 50;
  for (let x = gridSize; x < w; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = gridSize; y < h; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  if (!nodes || nodes.length === 0) {
    ctx.fillStyle = '#555580';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('记忆网络中暂无节点', w / 2, h / 2);
    ctx.fillText('请先与智能体交互以构建记忆图谱', w / 2, h / 2 + 24);
    return;
  }

  // 力导向布局模拟
  const simNodes = nodes.map(n => ({
    id: n.id,
    x: n.x || w / 2 + (Math.random() - 0.5) * w * 0.4,
    y: n.y || h / 2 + (Math.random() - 0.5) * h * 0.4,
    vx: 0, vy: 0,
    radius: n.radius || 5,
    color: n.color || '#8888bb',
    type: n.type,
    salience: n.salience || 1,
    isPulsar: n.isPulsar,
    title: n.title || '',
  }));

  const simEdges = (edges || []).map(e => ({
    source: simNodes.find(n => n.id === e.source),
    target: simNodes.find(n => n.id === e.target),
    strength: e.strength || 0.3,
    type: e.type,
  })).filter(e => e.source && e.target);

  // 简化力模拟
  const physics = memGraphState.graphData?.physics || {};
  const gravity = physics.gravity || 1.0;
  const repulsion = physics.repulsion || 2.0;
  const linkStrength = physics.linkStrength || 0.5;

  for (let iter = 0; iter < 50; iter++) {
    // 斥力
    for (let i = 0; i < simNodes.length; i++) {
      for (let j = i + 1; j < simNodes.length; j++) {
        const a = simNodes[i], b = simNodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = repulsion * 100 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // 引力 + 连线力
    for (const edge of simEdges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (dist - 60) * linkStrength * 0.01;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      edge.source.vx += fx; edge.source.vy += fy;
      edge.target.vx -= fx; edge.target.vy -= fy;
    }

    // 中心引力
    for (const node of simNodes) {
      const dx = w / 2 - node.x;
      const dy = h / 2 - node.y;
      node.vx += dx * gravity * 0.001;
      node.vy += dy * gravity * 0.001;
    }

    // 更新位置 + 阻尼
    for (const node of simNodes) {
      node.vx *= 0.9;
      node.vy *= 0.9;
      node.x += node.vx;
      node.y += node.vy;
      node.x = Math.max(20, Math.min(w - 20, node.x));
      node.y = Math.max(20, Math.min(h - 20, node.y));
    }
  }

  // 画聚类区域
  for (const cluster of (clusters || [])) {
    if (cluster.nodeCount < 2) continue;
    ctx.fillStyle = 'rgba(42, 42, 90, 0.08)';
    ctx.strokeStyle = 'rgba(68, 136, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    const cx = cluster.centroid?.x || w / 2;
    const cy = cluster.centroid?.y || h / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, cluster.nodeCount * 15 + 40, cluster.nodeCount * 12 + 30, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    // 聚类标签
    ctx.fillStyle = 'rgba(136, 136, 187, 0.5)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cluster.label || '', cx, cy - cluster.nodeCount * 12 - 35);
  }

  // 画连线
  for (const edge of simEdges) {
    const alpha = edge.type === 'entangled' ? 0.2 + Math.sin(Date.now() * 0.003) * 0.1 : edge.strength * 0.3;
    ctx.strokeStyle = `rgba(68, 136, 255, ${alpha})`;
    ctx.lineWidth = edge.type === 'entangled' ? 1.5 : edge.strength * 2;
    if (edge.type === 'entangled') ctx.setLineDash([3, 6]);

    ctx.beginPath();
    ctx.moveTo(edge.source.x, edge.source.y);
    ctx.lineTo(edge.target.x, edge.target.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 画节点
  for (const node of simNodes) {
    const r = node.radius;

    // 黑洞光晕
    if (node.salience >= 4.0) {
      const gradient = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, r * 3);
      gradient.addColorStop(0, 'rgba(68, 221, 238, 0.2)');
      gradient.addColorStop(1, 'rgba(68, 221, 238, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 脉冲星光环
    if (node.isPulsar) {
      const pulseR = r + Math.sin(Date.now() * 0.005 + parseFloat(node.id?.slice(-4) || 0)) * 4;
      ctx.strokeStyle = 'rgba(204, 68, 255, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, pulseR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 主体
    ctx.fillStyle = node.color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fill();

    // 发光
    ctx.shadowColor = node.color;
    ctx.shadowBlur = node.salience >= 4.0 ? 12 : 4;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 标题
    if (simNodes.length < 30) {
      ctx.fillStyle = '#e0e0ff';
      ctx.font = `${Math.max(9, r * 0.8)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(node.title?.substring(0, 10) || '', node.x, node.y - r - 8);
    }
  }

  // 全屏图持续动画
  memGraphState.fullAnimFrame = requestAnimationFrame(() => {
    const modal = document.getElementById('memgraph-full-modal');
    if (modal && modal.style.display === 'flex') {
      renderFullMemoryGraph();
    }
  });
}

async function cycleMemoryGraphLayout() {
  const layouts = ['force', 'spiral', 'radial', 'constellation'];
  const currentIdx = layouts.indexOf(memGraphState.layoutMode);
  memGraphState.layoutMode = layouts[(currentIdx + 1) % layouts.length];

  await API.setMemoryGraphLayout(memGraphState.layoutMode);
  await refreshMemoryGraphPanel();

  addSystemMessage(`🕸 记忆图布局切换: ${memGraphState.layoutMode}`);
}

// 全屏视图的物理参数处理
function handleMemGraphPhysicsChange() {
  const gravity = parseFloat(document.getElementById('memgraph-gravity-slider')?.value || 1.0);
  const repulsion = parseFloat(document.getElementById('memgraph-repulsion-slider')?.value || 2.0);
  const linkStrength = parseFloat(document.getElementById('memgraph-link-slider')?.value || 0.5);

  document.getElementById('memgraph-gravity-val').textContent = gravity.toFixed(1) + 'x';
  document.getElementById('memgraph-repulsion-val').textContent = repulsion.toFixed(1) + 'x';
  document.getElementById('memgraph-link-val').textContent = linkStrength.toFixed(2) + 'x';

  API.setMemoryGraphPhysics({ gravity, repulsion, linkStrength });
}

async function handleMemGraphLayoutChange() {
  const select = document.getElementById('memgraph-layout-select');
  if (!select) return;
  memGraphState.layoutMode = select.value;
  await API.setMemoryGraphLayout(select.value);
  await refreshMemoryGraphPanel();
}

async function handleMemGraphClusterChange() {
  const select = document.getElementById('memgraph-cluster-select');
  if (!select) return;
  memGraphState.clusterMode = select.value;
  await API.setMemoryGraphCluster(select.value);
  await refreshMemoryGraphPanel();
}

function fitMemoryGraphView() {
  // 重置物理参数到默认值
  document.getElementById('memgraph-gravity-slider').value = 1.0;
  document.getElementById('memgraph-repulsion-slider').value = 2.0;
  document.getElementById('memgraph-link-slider').value = 0.5;
  handleMemGraphPhysicsChange();
}

// 暴露到全局
window._openMessagePipelineDetail = openMessagePipelineDetail;
window._closeMessagePipelineDetail = closeMessagePipelineDetail;
window._openMessageDAGView = openMessageDAGView;
window._closeMessageDAGView = closeMessageDAGView;
window._openFullMemoryGraph = openFullMemoryGraph;
window._closeFullMemoryGraph = closeFullMemoryGraph;
window._cycleMemoryGraphLayout = cycleMemoryGraphLayout;
window._handleMemGraphPhysicsChange = handleMemGraphPhysicsChange;
window._handleMemGraphLayoutChange = handleMemGraphLayoutChange;
window._handleMemGraphClusterChange = handleMemGraphClusterChange;
window._fitMemoryGraphView = fitMemoryGraphView;

// ═══════════════════════════════════════
// v5.0: 系统设置初始化
// ═══════════════════════════════════════

async function initSettings() {
  try {
    // 加载设置管理器
    if (window.TriCoreSettings) {
      await window.TriCoreSettings.load();
      // 应用已保存的主题和字体
      const theme = window.TriCoreSettings.get('ui.theme');
      const fontSize = window.TriCoreSettings.get('ui.fontSize');
      if (theme && window.TriCoreSettings._applyImmediate) {
        window.TriCoreSettings._applyImmediate('ui.theme', theme);
      }
      if (fontSize) {
        document.documentElement.style.setProperty('--font-size-base', fontSize + 'px');
        document.documentElement.style.fontSize = fontSize + 'px';
      }
    }
  } catch (e) {
    console.warn('[BrainUI] 设置初始化失败:', e.message);
  }

  // 绑定设置按钮
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', async () => {
      if (window.TriCoreSettingsPanel) {
        await window.TriCoreSettingsPanel.open();
      } else {
        alert('设置面板加载中，请稍后再试...');
      }
    });
  }

  // 全局快捷键: Ctrl+, 打开设置
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      if (window.TriCoreSettingsPanel) {
        window.TriCoreSettingsPanel.toggle();
      }
    }
    // v6.0: Ctrl+Shift+D 打开系统自检
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      if (window.openSystemSelfCheck) {
        window.openSystemSelfCheck();
      }
    }
  });
}

// ═══════════════════════════════════════
// v6.0: 首次运行检测
// ═══════════════════════════════════════

async function checkFirstRun() {
  try {
    // 等待一小段时间确保 UI 渲染完成
    await new Promise(r => setTimeout(r, 800));

    // 检查是否需要显示首次配置向导
    if (window.launchOnboardingIfNeeded) {
      const launched = await window.launchOnboardingIfNeeded();
      if (launched) {
        LOG.info('[BrainUI] 首次启动配置向导已触发');
      }
    }
  } catch (e) {
    console.warn('[BrainUI] 首次运行检测失败:', e.message);
  }
}

// ═══════════════════════════════════════
// 启动
// ═══════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
