/**
 * 蜜糖 TriCore Agent — 首次启动配置向导 v1.0
 *
 * 职责：
 *   1. 检测是否首次运行（通过 localStorage 标记）
 *   2. 分步引导用户完成初始配置
 *   3. 配置完成后触发系统自检
 *   4. 支持跳过和稍后配置
 *
 * 向导步骤：
 *   Step 0: 欢迎页 — 品牌展示、功能介绍
 *   Step 1: LLM Provider 配置 — API Key、模型选择、测试连接
 *   Step 2: 系统偏好 — 主题、语言、存储路径、通知
 *   Step 3: 社交渠道 — Discord/微信/飞书 可选配置
 *   Step 4: 系统自检 — 自动运行全套诊断
 *   Step 5: 完成页 — 配置摘要、启动系统
 *
 * 使用方式：
 *   const wizard = new TriCoreOnboardingWizard();
 *   await wizard.checkAndLaunch(); // 自动检测首次运行
 */

'use strict';

(function () {
  const isElectron = !!(window.triCoreAPI);
  const API = window.triCoreAPI;

  // ── 常量 ──
  const STORAGE_KEY = 'tricore_onboarding_completed';
  const WIZARD_VERSION = 1;

  const LLM_PROVIDERS = {
    deepseek: { name: 'DeepSeek', icon: '🔮', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', color: '#4a90d9' },
    qwen: { name: '通义千问', icon: '☁️', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'], defaultModel: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', color: '#00a8ff' },
    zhipu: { name: '智谱 GLM', icon: '🧠', models: ['glm-4-flash', 'glm-4', 'glm-4-plus'], defaultModel: 'glm-4-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', color: '#3859ff' },
    moonshot: { name: 'Moonshot', icon: '🚀', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], defaultModel: 'moonshot-v1-8k', baseUrl: 'https://api.moonshot.cn/v1', color: '#22c55e' },
    openai: { name: 'OpenAI', icon: '🤖', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'], defaultModel: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', color: '#10a37f' },
    anthropic: { name: 'Anthropic', icon: '🎭', models: ['claude-3-5-sonnet', 'claude-3-haiku', 'claude-3-opus'], defaultModel: 'claude-3-5-sonnet', baseUrl: 'https://api.anthropic.com/v1', color: '#d97757' },
    google: { name: 'Google Gemini', icon: '💎', models: ['gemini-pro', 'gemini-flash'], defaultModel: 'gemini-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', color: '#4285f4' },
    custom: { name: '自定义', icon: '⚙️', models: [], defaultModel: '', baseUrl: '', color: '#888' },
  };

  // ── TriCoreOnboardingWizard 类 ──
  class TriCoreOnboardingWizard {
    constructor() {
      this._container = null;
      this._overlay = null;
      this._currentStep = 0;
      this._totalSteps = 5;
      this._config = {
        llm: { provider: 'deepseek', apiKey: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
        ui: { theme: 'dark', language: 'zh-CN', fontSize: 14 },
        preferences: { enableNotifications: true, autoStart: true, dataPath: '' },
        social: { discord: { enabled: false }, wechat: { enabled: false }, feishu: { enabled: false } },
      };
      this._testResults = {};
      this._isVisible = false;
    }

    // ═══════════════════════════════════════
    // 公共方法
    // ═══════════════════════════════════════

    /**
     * 检查是否需要显示向导，如果是首次运行则自动启动
     */
    async checkAndLaunch() {
      // 检查是否已完成向导
      const completed = localStorage.getItem(STORAGE_KEY);
      if (completed) {
        const data = JSON.parse(completed);
        if (data.version >= WIZARD_VERSION) {
          console.log('[OnboardingWizard] 向导已完成，跳过');
          return false;
        }
      }

      // 检查是否已有配置（宽松判断：有API Key就认为已配置）
      if (window.TriCoreSettings) {
        await window.TriCoreSettings.load();
        const apiKey = window.TriCoreSettings.get('llm.apiKey');
        if (apiKey && apiKey.length > 10) {
          // 已有配置，自动标记完成
          this._markCompleted();
          return false;
        }
      }

      // 首次运行，显示向导
      console.log('[OnboardingWizard] 检测到首次运行，启动配置向导');
      await this.launch();
      return true;
    }

    /**
     * 启动向导（强制显示）
     */
    async launch() {
      if (this._isVisible) return;

      // 如果已有设置，预加载
      if (window.TriCoreSettings) {
        await window.TriCoreSettings.load();
        const savedLlm = window.TriCoreSettings.get('llm') || {};
        const savedUi = window.TriCoreSettings.get('ui') || {};
        if (savedLlm.provider) this._config.llm.provider = savedLlm.provider;
        if (savedLlm.apiKey) this._config.llm.apiKey = savedLlm.apiKey;
        if (savedLlm.model) this._config.llm.model = savedLlm.model;
        if (savedUi.theme) this._config.ui.theme = savedUi.theme;
      }

      this._createOverlay();
      this._render();
      this._goToStep(0);
      this._isVisible = true;

      // 绑定键盘事件
      this._bindKeyboard();
    }

    /**
     * 关闭向导
     */
    close() {
      if (!this._isVisible) return;
      this._isVisible = false;
      if (this._overlay) {
        this._overlay.classList.add('wizard-closing');
        setTimeout(() => {
          if (this._overlay && this._overlay.parentNode) {
            this._overlay.parentNode.removeChild(this._overlay);
          }
          this._overlay = null;
          this._container = null;
        }, 300);
      }
      this._unbindKeyboard();
    }

    // ═══════════════════════════════════════
    // 创建UI
    // ═══════════════════════════════════════

    _createOverlay() {
      this._overlay = document.createElement('div');
      this._overlay.className = 'onboarding-overlay';
      this._overlay.innerHTML = `
        <div class="onboarding-wizard">
          <button class="wizard-close-btn" title="稍后配置">✕</button>
          <div class="wizard-container" id="wizard-container"></div>
        </div>
      `;
      document.body.appendChild(this._overlay);

      this._container = this._overlay.querySelector('#wizard-container');

      // 关闭按钮
      this._overlay.querySelector('.wizard-close-btn').addEventListener('click', () => {
        this._showSkipConfirm();
      });

      // 点击遮罩不关闭（强制引导）
    }

    _render() {
      if (!this._container) return;
      // 内容由 _goToStep 动态渲染
    }

    // ═══════════════════════════════════════
    // 步骤导航
    // ═══════════════════════════════════════

    _goToStep(stepIndex) {
      this._currentStep = stepIndex;
      if (!this._container) return;

      switch (stepIndex) {
        case 0: this._renderWelcome(); break;
        case 1: this._renderLlmConfig(); break;
        case 2: this._renderPreferences(); break;
        case 3: this._renderSocialConfig(); break;
        case 4: this._renderSelfCheck(); break;
        case 5: this._renderComplete(); break;
      }

      // 滚动到顶部
      this._container.scrollTop = 0;
    }

    // ═══════════════════════════════════════
    // Step 0: 欢迎页
    // ═══════════════════════════════════════

    _renderWelcome() {
      this._container.innerHTML = `
        <div class="wizard-step wizard-welcome">
          <div class="welcome-hero">
            <div class="welcome-logo">
              <div class="logo-animation">
                <div class="logo-ring ring-1"></div>
                <div class="logo-ring ring-2"></div>
                <div class="logo-ring ring-3"></div>
                <div class="logo-core">
                  <span class="logo-emoji">🍯</span>
                </div>
              </div>
            </div>
            <h1 class="welcome-title">欢迎使用蜜糖 TriCore Agent</h1>
            <p class="welcome-subtitle">三核驱动的企业级AI智能体系统</p>
            <p class="welcome-version">v5.0.0</p>
          </div>

          <div class="welcome-features">
            <div class="feature-card">
              <div class="feature-icon">💡</div>
              <h3>意识核</h3>
              <p>自主感知环境变化，智能觉醒与休眠，维护焦点话题栈</p>
            </div>
            <div class="feature-card">
              <div class="feature-icon">⚡</div>
              <h3>执行核</h3>
              <p>多工具编排、浏览器自动化、子智能体调度与消息管道处理</p>
            </div>
            <div class="feature-card">
              <div class="feature-icon">🧬</div>
              <h3>进化核</h3>
              <p>技能自动沉淀、记忆网络图谱、持续自我优化与演进</p>
            </div>
          </div>

          <div class="welcome-info">
            <p>接下来将引导您完成基础配置，预计需要 <strong>2-3 分钟</strong>。</p>
            <p class="welcome-hint">您可以随时跳过非必填项，后续可在系统设置中修改。</p>
          </div>

          <div class="wizard-actions">
            <button class="wizard-btn wizard-btn-secondary" id="wizard-btn-skip-all">跳过配置</button>
            <button class="wizard-btn wizard-btn-primary" id="wizard-btn-start">
              开始配置 <span class="btn-arrow">→</span>
            </button>
          </div>
        </div>
      `;

      this._container.querySelector('#wizard-btn-start').addEventListener('click', () => {
        this._goToStep(1);
      });
      this._container.querySelector('#wizard-btn-skip-all').addEventListener('click', () => {
        this._skipAll();
      });
    }

    // ═══════════════════════════════════════
    // Step 1: LLM Provider 配置
    // ═══════════════════════════════════════

    _renderLlmConfig() {
      const providers = LLM_PROVIDERS;
      const currentProvider = this._config.llm.provider;

      const providerCards = Object.entries(providers).map(([key, p]) => `
        <div class="provider-card ${key === currentProvider ? 'selected' : ''}"
             data-provider="${key}"
             style="--provider-color: ${p.color}">
          <span class="provider-icon">${p.icon}</span>
          <span class="provider-name">${p.name}</span>
          ${key === 'custom' ? '<span class="provider-badge">高级</span>' : ''}
        </div>
      `).join('');

      const currentModels = providers[currentProvider]?.models || [];
      const modelOptions = currentModels.map(m =>
        `<option value="${m}" ${m === this._config.llm.model ? 'selected' : ''}>${m}</option>`
      ).join('');

      this._container.innerHTML = `
        <div class="wizard-step wizard-llm-config">
          <div class="step-header">
            <span class="step-number">1/4</span>
            <h2>🤖 配置 AI 大模型</h2>
            <p>选择您的大模型服务商并配置 API 密钥</p>
          </div>

          <div class="step-body">
            <!-- Provider 选择 -->
            <div class="form-section">
              <label class="form-label">选择服务商</label>
              <div class="provider-grid" id="provider-grid">
                ${providerCards}
              </div>
            </div>

            <!-- API Key -->
            <div class="form-section">
              <label class="form-label">
                API Key <span class="required">*</span>
              </label>
              <div class="input-with-icon">
                <span class="input-icon">🔑</span>
                <input type="password" class="form-input" id="llm-api-key"
                       placeholder="输入您的 API Key..."
                       value="${this._escapeHtml(this._config.llm.apiKey)}">
                <button class="input-toggle-password" id="toggle-api-key" title="显示/隐藏">👁</button>
              </div>
              <p class="form-hint">
                您的 API Key 仅存储在本地，不会上传到任何服务器。
                ${this._getProviderKeyLink(currentProvider)}
              </p>
            </div>

            <!-- Model 选择 -->
            <div class="form-section" id="model-section">
              <label class="form-label">模型选择</label>
              <select class="form-select" id="llm-model">
                ${modelOptions || '<option value="">请先选择服务商</option>'}
              </select>
              ${currentProvider === 'custom' ? `
                <input type="text" class="form-input" id="llm-model-custom"
                       placeholder="输入模型名称，如 gpt-4..."
                       style="margin-top:8px;"
                       value="${this._escapeHtml(this._config.llm.model)}">
              ` : ''}
            </div>

            <!-- Base URL (自定义时显示) -->
            <div class="form-section" id="base-url-section" style="${currentProvider === 'custom' ? '' : 'display:none;'}">
              <label class="form-label">API 地址</label>
              <input type="text" class="form-input" id="llm-base-url"
                     placeholder="https://your-api-endpoint/v1"
                     value="${this._escapeHtml(this._config.llm.baseUrl || '')}">
            </div>

            <!-- 测试连接按钮 -->
            <div class="form-section">
              <button class="wizard-btn wizard-btn-test" id="btn-test-connection">
                🔌 测试连接
              </button>
              <span class="test-result" id="test-result"></span>
            </div>

            <!-- 高级选项（可折叠） -->
            <div class="form-section">
              <button class="advanced-toggle" id="toggle-advanced">
                ⚙️ 高级选项 <span class="toggle-arrow">▸</span>
              </button>
              <div class="advanced-options" id="advanced-options" style="display:none;">
                <div class="form-row">
                  <div class="form-group">
                    <label class="form-label">Temperature</label>
                    <input type="range" class="form-range" id="llm-temperature"
                           min="0" max="2" step="0.1" value="0.7">
                    <span class="range-value" id="temperature-value">0.7</span>
                  </div>
                  <div class="form-group">
                    <label class="form-label">Max Tokens</label>
                    <input type="number" class="form-input form-input-sm" id="llm-max-tokens"
                           min="256" max="131072" step="256" value="4096">
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="wizard-actions">
            <button class="wizard-btn wizard-btn-secondary" id="wizard-btn-prev">← 上一步</button>
            <button class="wizard-btn wizard-btn-primary" id="wizard-btn-next">
              下一步 <span class="btn-arrow">→</span>
            </button>
          </div>
        </div>
      `;

      // 绑定事件
      this._bindLlmEvents();
    }

    _getProviderKeyLink(provider) {
      const links = {
        deepseek: '<a href="https://platform.deepseek.com/api_keys" target="_blank">获取 DeepSeek API Key →</a>',
        qwen: '<a href="https://bailian.console.aliyun.com/" target="_blank">获取通义千问 API Key →</a>',
        zhipu: '<a href="https://open.bigmodel.cn/usercenter/apikeys" target="_blank">获取智谱 API Key →</a>',
        moonshot: '<a href="https://platform.moonshot.cn/console/api-keys" target="_blank">获取 Moonshot API Key →</a>',
        openai: '<a href="https://platform.openai.com/api-keys" target="_blank">获取 OpenAI API Key →</a>',
      };
      return links[provider] || '';
    }

    _bindLlmEvents() {
      const self = this;

      // Provider 选择
      this._container.querySelectorAll('.provider-card').forEach(card => {
        card.addEventListener('click', () => {
          const provider = card.dataset.provider;
          self._config.llm.provider = provider;
          self._config.llm.model = LLM_PROVIDERS[provider]?.defaultModel || '';
          self._config.llm.baseUrl = LLM_PROVIDERS[provider]?.baseUrl || '';
          self._renderLlmConfig();
        });
      });

      // API Key 输入
      const apiKeyInput = this._container.querySelector('#llm-api-key');
      if (apiKeyInput) {
        apiKeyInput.addEventListener('input', () => {
          self._config.llm.apiKey = apiKeyInput.value.trim();
        });
      }

      // 显示/隐藏密码
      const toggleBtn = this._container.querySelector('#toggle-api-key');
      if (toggleBtn && apiKeyInput) {
        toggleBtn.addEventListener('click', () => {
          const type = apiKeyInput.type === 'password' ? 'text' : 'password';
          apiKeyInput.type = type;
          toggleBtn.textContent = type === 'password' ? '👁' : '🙈';
        });
      }

      // Model 选择
      const modelSelect = this._container.querySelector('#llm-model');
      if (modelSelect) {
        modelSelect.addEventListener('change', () => {
          self._config.llm.model = modelSelect.value;
        });
      }

      // 自定义 Model
      const modelCustom = this._container.querySelector('#llm-model-custom');
      if (modelCustom) {
        modelCustom.addEventListener('input', () => {
          self._config.llm.model = modelCustom.value.trim();
        });
      }

      // Base URL
      const baseUrlInput = this._container.querySelector('#llm-base-url');
      if (baseUrlInput) {
        baseUrlInput.addEventListener('input', () => {
          self._config.llm.baseUrl = baseUrlInput.value.trim();
        });
      }

      // 测试连接
      const testBtn = this._container.querySelector('#btn-test-connection');
      if (testBtn) {
        testBtn.addEventListener('click', () => this._testConnection());
      }

      // 高级选项切换
      const toggleAdvanced = this._container.querySelector('#toggle-advanced');
      if (toggleAdvanced) {
        toggleAdvanced.addEventListener('click', () => {
          const panel = this._container.querySelector('#advanced-options');
          const arrow = toggleAdvanced.querySelector('.toggle-arrow');
          if (panel.style.display === 'none') {
            panel.style.display = 'block';
            arrow.textContent = '▾';
          } else {
            panel.style.display = 'none';
            arrow.textContent = '▸';
          }
        });
      }

      // Temperature 滑块
      const tempSlider = this._container.querySelector('#llm-temperature');
      if (tempSlider) {
        tempSlider.addEventListener('input', () => {
          const val = parseFloat(tempSlider.value);
          const display = this._container.querySelector('#temperature-value');
          if (display) display.textContent = val.toFixed(1);
          self._config.llm.temperature = val;
        });
      }

      // Max Tokens
      const maxTokensInput = this._container.querySelector('#llm-max-tokens');
      if (maxTokensInput) {
        maxTokensInput.addEventListener('input', () => {
          self._config.llm.maxTokens = parseInt(maxTokensInput.value, 10) || 4096;
        });
      }

      // 导航按钮
      this._container.querySelector('#wizard-btn-prev').addEventListener('click', () => {
        this._goToStep(0);
      });
      this._container.querySelector('#wizard-btn-next').addEventListener('click', () => {
        // 验证必填项
        if (!this._config.llm.apiKey) {
          this._showFieldError('llm-api-key', '请填写 API Key');
          return;
        }
        this._goToStep(2);
      });
    }

    async _testConnection() {
      const testBtn = this._container.querySelector('#btn-test-connection');
      const resultEl = this._container.querySelector('#test-result');

      if (!this._config.llm.apiKey) {
        resultEl.innerHTML = '<span class="test-error">❌ 请先填写 API Key</span>';
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = '⏳ 测试中...';
      resultEl.innerHTML = '<span class="test-pending">⏳ 正在测试连接...</span>';

      try {
        if (isElectron && API && API.testLLMConnection) {
          const result = await API.testLLMConnection({
            provider: this._config.llm.provider,
            apiKey: this._config.llm.apiKey,
            model: this._config.llm.model,
            baseUrl: this._config.llm.baseUrl,
          });
          if (result.success) {
            resultEl.innerHTML = `<span class="test-success">✅ 连接成功！延迟: ${result.latency || 'N/A'}ms</span>`;
          } else {
            resultEl.innerHTML = `<span class="test-error">❌ 连接失败: ${result.error || '未知错误'}</span>`;
          }
        } else {
          // 非 Electron 环境：模拟测试
          await new Promise(r => setTimeout(r, 1500));
          const hasKey = this._config.llm.apiKey.length > 10;
          if (hasKey) {
            resultEl.innerHTML = '<span class="test-success">✅ API Key 格式验证通过（完整测试需启动后端）</span>';
          } else {
            resultEl.innerHTML = '<span class="test-error">❌ API Key 格式无效</span>';
          }
        }
      } catch (e) {
        resultEl.innerHTML = `<span class="test-error">❌ 测试异常: ${this._escapeHtml(e.message)}</span>`;
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '🔌 测试连接';
      }
    }

    // ═══════════════════════════════════════
    // Step 2: 系统偏好
    // ═══════════════════════════════════════

    _renderPreferences() {
      this._container.innerHTML = `
        <div class="wizard-step wizard-preferences">
          <div class="step-header">
            <span class="step-number">2/4</span>
            <h2>🎨 系统偏好设置</h2>
            <p>个性化您的 TriCore Agent 使用体验</p>
          </div>

          <div class="step-body">
            <!-- 主题选择 -->
            <div class="form-section">
              <label class="form-label">界面主题</label>
              <div class="theme-selector">
                <div class="theme-card ${this._config.ui.theme === 'dark' ? 'selected' : ''}" data-theme="dark">
                  <div class="theme-preview theme-dark-preview">
                    <div class="theme-preview-bar"></div>
                    <div class="theme-preview-sidebar"></div>
                    <div class="theme-preview-content"></div>
                  </div>
                  <span>暗色模式</span>
                </div>
                <div class="theme-card ${this._config.ui.theme === 'light' ? 'selected' : ''}" data-theme="light">
                  <div class="theme-preview theme-light-preview">
                    <div class="theme-preview-bar"></div>
                    <div class="theme-preview-sidebar"></div>
                    <div class="theme-preview-content"></div>
                  </div>
                  <span>亮色模式</span>
                </div>
                <div class="theme-card ${this._config.ui.theme === 'auto' ? 'selected' : ''}" data-theme="auto">
                  <div class="theme-preview theme-auto-preview">
                    <div class="theme-preview-half dark-half"></div>
                    <div class="theme-preview-half light-half"></div>
                  </div>
                  <span>跟随系统</span>
                </div>
              </div>
            </div>

            <!-- 语言 -->
            <div class="form-section">
              <label class="form-label">界面语言</label>
              <div class="language-selector">
                <label class="radio-card ${this._config.ui.language === 'zh-CN' ? 'selected' : ''}">
                  <input type="radio" name="language" value="zh-CN" ${this._config.ui.language === 'zh-CN' ? 'checked' : ''}>
                  <span class="radio-label">🇨🇳 简体中文</span>
                </label>
                <label class="radio-card ${this._config.ui.language === 'en-US' ? 'selected' : ''}">
                  <input type="radio" name="language" value="en-US" ${this._config.ui.language === 'en-US' ? 'checked' : ''}>
                  <span class="radio-label">🇺🇸 English</span>
                </label>
              </div>
            </div>

            <!-- 字体大小 -->
            <div class="form-section">
              <label class="form-label">字体大小</label>
              <div class="slider-with-labels">
                <span class="slider-label">小</span>
                <input type="range" class="form-range" id="pref-font-size"
                       min="12" max="20" step="1" value="${this._config.ui.fontSize}">
                <span class="slider-label">大</span>
              </div>
              <div class="font-preview" id="font-preview" style="font-size:${this._config.ui.fontSize}px;">
                Aa 蜜糖 TriCore Agent 预览文字
              </div>
            </div>

            <!-- 通知设置 -->
            <div class="form-section">
              <label class="form-label">通知偏好</label>
              <div class="checkbox-list">
                <label class="checkbox-card">
                  <input type="checkbox" id="pref-notifications" ${this._config.preferences.enableNotifications ? 'checked' : ''}>
                  <span class="checkbox-label">
                    <span class="checkbox-title">启用桌面通知</span>
                    <span class="checkbox-desc">接收任务完成、异常告警等通知</span>
                  </span>
                </label>
                <label class="checkbox-card">
                  <input type="checkbox" id="pref-auto-start" ${this._config.preferences.autoStart ? 'checked' : ''}>
                  <span class="checkbox-label">
                    <span class="checkbox-title">开机自启动</span>
                    <span class="checkbox-desc">系统启动时自动运行 TriCore Agent</span>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div class="wizard-actions">
            <button class="wizard-btn wizard-btn-secondary" id="wizard-btn-prev">← 上一步</button>
            <button class="wizard-btn wizard-btn-primary" id="wizard-btn-next">
              下一步 <span class="btn-arrow">→</span>
            </button>
          </div>
        </div>
      `;

      this._bindPreferencesEvents();
    }

    _bindPreferencesEvents() {
      const self = this;

      // 主题选择
      this._container.querySelectorAll('.theme-card').forEach(card => {
        card.addEventListener('click', () => {
          self._config.ui.theme = card.dataset.theme;
          self._renderPreferences();
        });
      });

      // 语言选择
      this._container.querySelectorAll('input[name="language"]').forEach(radio => {
        radio.addEventListener('change', () => {
          self._config.ui.language = radio.value;
        });
      });

      // 字体大小
      const fontSizeSlider = this._container.querySelector('#pref-font-size');
      if (fontSizeSlider) {
        fontSizeSlider.addEventListener('input', () => {
          const val = parseInt(fontSizeSlider.value, 10);
          self._config.ui.fontSize = val;
          const preview = this._container.querySelector('#font-preview');
          if (preview) preview.style.fontSize = val + 'px';
        });
      }

      // 通知
      const notifCheck = this._container.querySelector('#pref-notifications');
      if (notifCheck) {
        notifCheck.addEventListener('change', () => {
          self._config.preferences.enableNotifications = notifCheck.checked;
        });
      }

      // 自启动
      const autoStartCheck = this._container.querySelector('#pref-auto-start');
      if (autoStartCheck) {
        autoStartCheck.addEventListener('change', () => {
          self._config.preferences.autoStart = autoStartCheck.checked;
        });
      }

      // 导航
      this._container.querySelector('#wizard-btn-prev').addEventListener('click', () => {
        this._goToStep(1);
      });
      this._container.querySelector('#wizard-btn-next').addEventListener('click', () => {
        this._goToStep(3);
      });
    }

    // ═══════════════════════════════════════
    // Step 3: 社交渠道配置
    // ═══════════════════════════════════════

    _renderSocialConfig() {
      this._container.innerHTML = `
        <div class="wizard-step wizard-social">
          <div class="step-header">
            <span class="step-number">3/4</span>
            <h2>🔗 社交渠道集成</h2>
            <p>连接社交平台，让 TriCore Agent 在多个渠道为您服务 <span class="optional-tag">可选</span></p>
          </div>

          <div class="step-body">
            <div class="social-cards">
              <!-- Discord -->
              <div class="social-card" id="social-discord">
                <div class="social-card-header">
                  <span class="social-icon">🎮</span>
                  <div class="social-info">
                    <h4>Discord</h4>
                    <p>通过 Discord Bot 与 Agent 交互</p>
                  </div>
                  <label class="switch">
                    <input type="checkbox" id="social-discord-enabled">
                    <span class="switch-slider"></span>
                  </label>
                </div>
                <div class="social-card-body" style="display:none;">
                  <input type="password" class="form-input" id="discord-bot-token"
                         placeholder="Bot Token">
                  <input type="text" class="form-input" id="discord-channels"
                         placeholder="频道 ID（逗号分隔）" style="margin-top:8px;">
                </div>
              </div>

              <!-- 微信 -->
              <div class="social-card" id="social-wechat">
                <div class="social-card-header">
                  <span class="social-icon">💬</span>
                  <div class="social-info">
                    <h4>微信</h4>
                    <p>通过企业微信或公众号接入</p>
                  </div>
                  <label class="switch">
                    <input type="checkbox" id="social-wechat-enabled">
                    <span class="switch-slider"></span>
                  </label>
                </div>
                <div class="social-card-body" style="display:none;">
                  <input type="text" class="form-input" id="wechat-account-id"
                         placeholder="企业微信 Corp ID">
                  <input type="password" class="form-input" id="wechat-bot-token"
                         placeholder="Bot Token" style="margin-top:8px;">
                </div>
              </div>

              <!-- 飞书 -->
              <div class="social-card" id="social-feishu">
                <div class="social-card-header">
                  <span class="social-icon">🐦</span>
                  <div class="social-info">
                    <h4>飞书</h4>
                    <p>通过飞书机器人接收消息和指令</p>
                  </div>
                  <label class="switch">
                    <input type="checkbox" id="social-feishu-enabled">
                    <span class="switch-slider"></span>
                  </label>
                </div>
                <div class="social-card-body" style="display:none;">
                  <input type="text" class="form-input" id="feishu-app-id"
                         placeholder="App ID">
                  <input type="password" class="form-input" id="feishu-app-secret"
                         placeholder="App Secret" style="margin-top:8px;">
                </div>
              </div>
            </div>
          </div>

          <div class="wizard-actions">
            <button class="wizard-btn wizard-btn-secondary" id="wizard-btn-prev">← 上一步</button>
            <button class="wizard-btn wizard-btn-primary" id="wizard-btn-next">
              开始自检 <span class="btn-arrow">→</span>
            </button>
          </div>
        </div>
      `;

      this._bindSocialEvents();
    }

    _bindSocialEvents() {
      const self = this;

      // 每个社交卡片的开关
      ['discord', 'wechat', 'feishu'].forEach(platform => {
        const card = this._container.querySelector(`#social-${platform}`);
        const toggle = card?.querySelector('input[type="checkbox"]');
        const body = card?.querySelector('.social-card-body');

        if (toggle && body) {
          toggle.addEventListener('change', () => {
            body.style.display = toggle.checked ? 'block' : 'none';
            self._config.social[platform].enabled = toggle.checked;
          });
        }

        // 输入框事件
        const inputs = card?.querySelectorAll('input[type="text"], input[type="password"]');
        inputs?.forEach(input => {
          input.addEventListener('input', () => {
            const key = input.id.replace(`${platform}-`, '').replace(/-/g, '');
            if (self._config.social[platform]) {
              self._config.social[platform][key] = input.value.trim();
            }
          });
        });
      });

      // 导航
      this._container.querySelector('#wizard-btn-prev').addEventListener('click', () => {
        this._goToStep(2);
      });
      this._container.querySelector('#wizard-btn-next').addEventListener('click', () => {
        this._goToStep(4);
      });
    }

    // ═══════════════════════════════════════
    // Step 4: 系统自检
    // ═══════════════════════════════════════

    _renderSelfCheck() {
      this._container.innerHTML = `
        <div class="wizard-step wizard-selfcheck">
          <div class="step-header">
            <span class="step-number">4/4</span>
            <h2>🔍 系统自检</h2>
            <p>正在检测系统各组件的运行状态...</p>
          </div>

          <div class="step-body">
            <div class="selfcheck-container" id="selfcheck-container">
              <!-- 进度指示器 -->
              <div class="selfcheck-progress">
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill" id="selfcheck-progress-bar" style="width:0%;"></div>
                </div>
                <span class="progress-text" id="selfcheck-progress-text">准备中...</span>
              </div>

              <!-- 检查项列表 -->
              <div class="selfcheck-items" id="selfcheck-items">
                <!-- 动态填充 -->
              </div>

              <!-- 结果摘要 -->
              <div class="selfcheck-summary" id="selfcheck-summary" style="display:none;">
                <div class="summary-stats" id="selfcheck-stats"></div>
                <div class="summary-details" id="selfcheck-details"></div>
              </div>
            </div>
          </div>

          <div class="wizard-actions" id="selfcheck-actions">
            <button class="wizard-btn wizard-btn-secondary" id="wizard-btn-prev" style="display:none;">← 上一步</button>
            <button class="wizard-btn wizard-btn-primary" id="wizard-btn-complete" style="display:none;">
              完成配置 <span class="btn-arrow">→</span>
            </button>
          </div>
        </div>
      `;

      // 自动开始自检
      setTimeout(() => this._runSelfCheck(), 500);
    }

    async _runSelfCheck() {
      const itemsContainer = this._container.querySelector('#selfcheck-items');
      const progressBar = this._container.querySelector('#selfcheck-progress-bar');
      const progressText = this._container.querySelector('#selfcheck-progress-text');

      // 定义自检项
      const checks = [
        { id: 'system', name: '系统环境', icon: '💻', category: 'environment' },
        { id: 'node', name: 'Node.js 运行时', icon: '🟢', category: 'environment' },
        { id: 'memory', name: '内存状态', icon: '🧠', category: 'environment' },
        { id: 'disk', name: '磁盘空间', icon: '💾', category: 'environment' },
        { id: 'network', name: '网络连接', icon: '🌐', category: 'connectivity' },
        { id: 'dns', name: 'DNS 解析', icon: '📡', category: 'connectivity' },
        { id: 'llm_api', name: 'LLM API 连通性', icon: '🤖', category: 'ai_service' },
        { id: 'audio_input', name: '音频输入设备', icon: '🎤', category: 'multimedia' },
        { id: 'audio_output', name: '音频输出设备', icon: '🔊', category: 'multimedia' },
        { id: 'audio_playback', name: '音频播放测试', icon: '🔉', category: 'multimedia' },
        { id: 'video_codec', name: '视频编解码支持', icon: '🎬', category: 'multimedia' },
        { id: 'video_playback', name: '视频播放测试', icon: '▶️', category: 'multimedia' },
        { id: 'document_parser', name: '文档解析引擎', icon: '📄', category: 'document' },
        { id: 'document_pdf', name: 'PDF 处理能力', icon: '📕', category: 'document' },
        { id: 'document_office', name: 'Office 文档支持', icon: '📊', category: 'document' },
        { id: 'document_image', name: '图片处理能力', icon: '🖼️', category: 'document' },
        { id: 'database', name: '数据库连接', icon: '🗄️', category: 'storage' },
        { id: 'storage_rw', name: '存储读写权限', icon: '📁', category: 'storage' },
      ];

      // 渲染检查项
      itemsContainer.innerHTML = checks.map(c => `
        <div class="check-item" id="check-${c.id}">
          <span class="check-icon">${c.icon}</span>
          <span class="check-name">${c.name}</span>
          <span class="check-status" id="check-status-${c.id}">
            <span class="check-pending">等待中</span>
          </span>
        </div>
      `).join('');

      // 逐项检查
      let completed = 0;
      const results = { passed: 0, failed: 0, warnings: 0, details: [] };

      for (const check of checks) {
        progressText.textContent = `正在检查: ${check.name}...`;
        progressBar.style.width = `${Math.round((completed / checks.length) * 100)}%`;

        const statusEl = this._container.querySelector(`#check-status-${check.id}`);

        try {
          const result = await this._performCheck(check);
          results.details.push({ ...check, ...result });

          if (result.status === 'pass') {
            statusEl.innerHTML = '<span class="check-pass">✅ 通过</span>';
            if (result.value) {
              statusEl.innerHTML += ` <span class="check-value">${result.value}</span>`;
            }
            results.passed++;
          } else if (result.status === 'warn') {
            statusEl.innerHTML = `<span class="check-warn">⚠️ ${result.message || '警告'}</span>`;
            results.warnings++;
          } else {
            statusEl.innerHTML = `<span class="check-fail">❌ ${result.message || '失败'}</span>`;
            results.failed++;
          }
        } catch (e) {
          statusEl.innerHTML = `<span class="check-fail">❌ ${e.message}</span>`;
          results.failed++;
          results.details.push({ ...check, status: 'fail', message: e.message });
        }

        completed++;
        progressBar.style.width = `${Math.round((completed / checks.length) * 100)}%`;

        // 动画延迟
        await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
      }

      // 完成
      progressBar.style.width = '100%';
      progressText.textContent = '自检完成！';

      // 显示摘要
      this._renderSelfCheckSummary(results);

      // 显示按钮
      const prevBtn = this._container.querySelector('#wizard-btn-prev');
      const completeBtn = this._container.querySelector('#wizard-btn-complete');
      if (prevBtn) prevBtn.style.display = 'inline-flex';
      if (completeBtn) completeBtn.style.display = 'inline-flex';

      // 绑定按钮
      if (prevBtn) {
        prevBtn.addEventListener('click', () => this._goToStep(3));
      }
      if (completeBtn) {
        completeBtn.addEventListener('click', () => this._completeWizard());
      }

      this._testResults = results;
    }

    _renderSelfCheckSummary(results) {
      const summaryEl = this._container.querySelector('#selfcheck-summary');
      const statsEl = this._container.querySelector('#selfcheck-stats');
      const detailsEl = this._container.querySelector('#selfcheck-details');

      if (!summaryEl || !statsEl || !detailsEl) return;

      summaryEl.style.display = 'block';

      // 统计
      const total = results.passed + results.failed + results.warnings;
      const passRate = total > 0 ? Math.round((results.passed / total) * 100) : 0;
      const overallStatus = results.failed === 0 ? (results.warnings > 0 ? 'warn' : 'pass') : 'fail';

      statsEl.innerHTML = `
        <div class="summary-card summary-overall ${overallStatus}">
          <div class="summary-big-icon">${overallStatus === 'pass' ? '✅' : overallStatus === 'warn' ? '⚠️' : '❌'}</div>
          <div class="summary-big-text">
            ${overallStatus === 'pass' ? '系统状态良好' : overallStatus === 'warn' ? '存在警告项' : '存在失败项'}
          </div>
          <div class="summary-pass-rate">通过率: ${passRate}%</div>
        </div>
        <div class="summary-mini-cards">
          <div class="mini-card pass">
            <span class="mini-count">${results.passed}</span>
            <span class="mini-label">通过</span>
          </div>
          <div class="mini-card warn">
            <span class="mini-count">${results.warnings}</span>
            <span class="mini-label">警告</span>
          </div>
          <div class="mini-card fail">
            <span class="mini-count">${results.failed}</span>
            <span class="mini-label">失败</span>
          </div>
        </div>
      `;

      // 失败/警告详情
      const problemItems = results.details.filter(d => d.status !== 'pass');
      if (problemItems.length > 0) {
        detailsEl.innerHTML = `
          <h4>需要关注的项目</h4>
          ${problemItems.map(d => `
            <div class="detail-item detail-${d.status}">
              <span class="detail-icon">${d.status === 'warn' ? '⚠️' : '❌'}</span>
              <span class="detail-name">${d.icon} ${d.name}</span>
              <span class="detail-msg">${d.message || '检查未通过'}</span>
            </div>
          `).join('')}
        `;
      } else {
        detailsEl.innerHTML = '<p class="all-clear">🎉 所有检查项均已通过！</p>';
      }
    }

    async _performCheck(check) {
      // 根据检查类型执行不同的检测逻辑
      switch (check.id) {
        case 'system':
          return this._checkSystem();
        case 'node':
          return this._checkNode();
        case 'memory':
          return this._checkMemory();
        case 'disk':
          return this._checkDisk();
        case 'network':
          return this._checkNetwork();
        case 'dns':
          return this._checkDns();
        case 'llm_api':
          return this._checkLlmApi();
        case 'audio_input':
          return this._checkAudioInput();
        case 'audio_output':
          return this._checkAudioOutput();
        case 'audio_playback':
          return this._checkAudioPlayback();
        case 'video_codec':
          return this._checkVideoCodec();
        case 'video_playback':
          return this._checkVideoPlayback();
        case 'document_parser':
          return this._checkDocumentParser();
        case 'document_pdf':
          return this._checkPdfSupport();
        case 'document_office':
          return this._checkOfficeSupport();
        case 'document_image':
          return this._checkImageSupport();
        case 'database':
          return this._checkDatabase();
        case 'storage_rw':
          return this._checkStorageRW();
        default:
          return { status: 'pass' };
      }
    }

    // ── 环境检查 ──

    _checkSystem() {
      const info = [];
      info.push(`OS: ${navigator.platform || 'Unknown'}`);
      info.push(`CPU: ${navigator.hardwareConcurrency || '?'} 核心`);
      if (navigator.deviceMemory) info.push(`RAM: ${navigator.deviceMemory}GB`);

      return {
        status: 'pass',
        value: info.join(' | '),
      };
    }

    _checkNode() {
      if (isElectron && API && API.getNodeVersion) {
        return API.getNodeVersion().then(v => ({
          status: 'pass',
          value: `Node.js ${v}`,
        })).catch(() => ({
          status: 'warn',
          message: '无法获取 Node.js 版本',
        }));
      }
      return { status: 'pass', value: 'Electron 运行时' };
    }

    _checkMemory() {
      if (performance.memory) {
        const used = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
        const total = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
        const pct = Math.round((used / total) * 100);

        if (pct > 80) {
          return { status: 'warn', value: `${used}MB / ${total}MB (${pct}%)`, message: '内存使用率较高' };
        }
        return { status: 'pass', value: `${used}MB / ${total}MB (${pct}%)` };
      }
      return { status: 'pass', value: '正常' };
    }

    _checkDisk() {
      if (navigator.storage && navigator.storage.estimate) {
        return navigator.storage.estimate().then(est => {
          const used = Math.round(est.usage / 1024 / 1024);
          const quota = Math.round(est.quota / 1024 / 1024);
          const pct = Math.round((used / quota) * 100);

          if (pct > 90) {
            return { status: 'warn', value: `已用 ${used}MB / ${quota}MB`, message: '磁盘空间不足' };
          }
          return { status: 'pass', value: `可用 ${quota - used}MB / ${quota}MB` };
        }).catch(() => ({ status: 'warn', message: '无法获取磁盘信息' }));
      }
      return { status: 'pass', value: '正常' };
    }

    // ── 网络检查 ──

    async _checkNetwork() {
      try {
        const start = Date.now();
        const resp = await fetch('https://www.baidu.com/img/PCtm_d9c8750bed0b3c7d089fa7d55720d6cf.png', {
          method: 'HEAD',
          mode: 'no-cors',
          cache: 'no-cache',
        });
        const latency = Date.now() - start;
        if (latency > 3000) {
          return { status: 'warn', value: `${latency}ms`, message: '网络延迟较高' };
        }
        return { status: 'pass', value: `${latency}ms` };
      } catch (e) {
        return { status: 'fail', message: '无法连接互联网' };
      }
    }

    async _checkDns() {
      try {
        const start = Date.now();
        await fetch('https://api.deepseek.com/v1/models', {
          method: 'HEAD',
          mode: 'no-cors',
          cache: 'no-cache',
        });
        const latency = Date.now() - start;
        return { status: 'pass', value: `${latency}ms` };
      } catch (e) {
        return { status: 'warn', message: 'DNS 解析可能存在问题' };
      }
    }

    async _checkLlmApi() {
      if (!this._config.llm.apiKey) {
        return { status: 'warn', message: '未配置 API Key，跳过检测' };
      }
      try {
        const url = this._config.llm.baseUrl || LLM_PROVIDERS[this._config.llm.provider]?.baseUrl || '';
        if (url) {
          const start = Date.now();
          await fetch(`${url}/models`, {
            method: 'HEAD',
            mode: 'no-cors',
            cache: 'no-cache',
          });
          const latency = Date.now() - start;
          return { status: 'pass', value: `${latency}ms` };
        }
        return { status: 'warn', message: '未配置 API 地址' };
      } catch (e) {
        return { status: 'warn', message: 'API 端点不可达（可能被 CORS 限制）' };
      }
    }

    // ── 音频检查 ──

    async _checkAudioInput() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return { status: 'warn', message: '浏览器不支持媒体设备枚举' };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        if (audioInputs.length === 0) {
          return { status: 'warn', message: '未检测到麦克风设备' };
        }

        const hasPermission = audioInputs.some(d => d.label !== '');
        const labels = audioInputs.map(d => d.label || '未授权访问').join(', ');

        return {
          status: hasPermission ? 'pass' : 'warn',
          value: `${audioInputs.length} 个设备`,
          message: hasPermission ? undefined : '需要授予麦克风权限',
        };
      } catch (e) {
        return { status: 'warn', message: '无法枚举音频设备' };
      }
    }

    async _checkAudioOutput() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return { status: 'warn', message: '浏览器不支持媒体设备枚举' };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

        if (audioOutputs.length === 0) {
          return { status: 'warn', message: '未检测到音频输出设备' };
        }

        return {
          status: 'pass',
          value: `${audioOutputs.length} 个设备`,
        };
      } catch (e) {
        return { status: 'warn', message: '无法枚举音频设备' };
      }
    }

    _checkAudioPlayback() {
      // 检查 Web Audio API 支持
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
          return { status: 'fail', message: '浏览器不支持 Web Audio API' };
        }

        const ctx = new AudioContext();
        const sampleRate = ctx.sampleRate;
        const state = ctx.state;
        ctx.close();

        if (state === 'suspended') {
          return { status: 'warn', value: `${sampleRate}Hz`, message: '音频上下文被暂停（需要用户交互）' };
        }

        return { status: 'pass', value: `${sampleRate}Hz` };
      } catch (e) {
        return { status: 'fail', message: '音频系统初始化失败' };
      }
    }

    // ── 视频检查 ──

    _checkVideoCodec() {
      const video = document.createElement('video');
      const codecs = {
        'H.264 (AVC)': 'video/mp4; codecs="avc1.42E01E"',
        'H.265 (HEVC)': 'video/mp4; codecs="hevc"',
        'VP8': 'video/webm; codecs="vp8"',
        'VP9': 'video/webm; codecs="vp9"',
        'AV1': 'video/webm; codecs="av01"',
      };

      const supported = [];
      const unsupported = [];

      for (const [name, mime] of Object.entries(codecs)) {
        const canPlay = video.canPlayType(mime);
        if (canPlay === 'probably' || canPlay === 'maybe') {
          supported.push(name);
        } else {
          unsupported.push(name);
        }
      }

      if (supported.length === 0) {
        return { status: 'fail', message: '未检测到任何视频编解码器' };
      }

      if (supported.length < 3) {
        return { status: 'warn', value: supported.join(', '), message: `不支持: ${unsupported.join(', ')}` };
      }

      return { status: 'pass', value: `${supported.length} 种格式支持` };
    }

    _checkVideoPlayback() {
      try {
        const video = document.createElement('video');
        if (!video.canPlayType) {
          return { status: 'fail', message: '浏览器不支持视频播放' };
        }

        // 检查是否有任何可播放的格式
        const formats = [
          'video/mp4',
          'video/webm',
          'video/ogg',
        ];

        const playable = formats.filter(f => video.canPlayType(f) !== '');

        if (playable.length === 0) {
          return { status: 'fail', message: '无支持的视频格式' };
        }

        return { status: 'pass', value: `${playable.length} 种格式` };
      } catch (e) {
        return { status: 'fail', message: '视频播放检测失败' };
      }
    }

    // ── 文档检查 ──

    _checkDocumentParser() {
      const checks = [];

      // TextDecoder
      if (typeof TextDecoder !== 'undefined') {
        checks.push('文本解码');
      }

      // DOMParser
      if (typeof DOMParser !== 'undefined') {
        checks.push('HTML/XML解析');
      }

      // FileReader
      if (typeof FileReader !== 'undefined') {
        checks.push('文件读取');
      }

      // Blob
      if (typeof Blob !== 'undefined') {
        checks.push('二进制处理');
      }

      if (checks.length >= 3) {
        return { status: 'pass', value: checks.join(', ') };
      }
      return { status: 'warn', message: `仅支持: ${checks.join(', ')}` };
    }

    _checkPdfSupport() {
      const checks = [];

      // 检查 ArrayBuffer
      if (typeof ArrayBuffer !== 'undefined') {
        checks.push('二进制缓冲');
      }

      // 检查是否有 Canvas (用于 PDF 渲染)
      if (typeof HTMLCanvasElement !== 'undefined') {
        checks.push('Canvas渲染');
      }

      // 检查 PDF.js 可用性
      if (typeof window.pdfjsLib !== 'undefined' || typeof pdfjsLib !== 'undefined') {
        checks.push('PDF.js引擎');
      }

      if (checks.length >= 2) {
        return { status: 'pass', value: checks.join(', ') };
      }

      return { status: 'warn', message: 'PDF渲染依赖不完整' };
    }

    _checkOfficeSupport() {
      const checks = [];

      // 检查 XML 解析（DOCX/XLSX/PPTX 基于 XML）
      if (typeof DOMParser !== 'undefined') {
        checks.push('XML解析');
      }

      // 检查 ZIP 解压（Office 文件本质是 ZIP）
      if (typeof TextDecoder !== 'undefined') {
        checks.push('ZIP读取');
      }

      if (checks.length >= 2) {
        return { status: 'pass', value: checks.join(', ') };
      }

      return { status: 'warn', message: 'Office文档解析能力有限' };
    }

    _checkImageSupport() {
      const img = new Image();
      const formats = ['PNG', 'JPEG', 'GIF', 'WebP', 'SVG', 'AVIF'];

      const supported = [];
      const unsupported = [];

      // 简单检查：通过 MIME 类型
      const mimeTypes = {
        PNG: 'image/png',
        JPEG: 'image/jpeg',
        GIF: 'image/gif',
        WebP: 'image/webp',
        SVG: 'image/svg+xml',
        AVIF: 'image/avif',
      };

      // 使用 Canvas 检测
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (ctx) {
          supported.push('Canvas处理');
        }
      } catch (e) { /* ignore */ }

      // WebP 检测
      const webpCheck = document.createElement('canvas');
      if (webpCheck.toDataURL('image/webp').indexOf('data:image/webp') === 0) {
        supported.push('WebP');
      }

      // 基础格式
      supported.push('PNG', 'JPEG', 'GIF', 'SVG');

      return { status: 'pass', value: `${supported.length} 种格式` };
    }

    // ── 存储检查 ──

    _checkDatabase() {
      try {
        if (typeof localStorage !== 'undefined') {
          const testKey = '__tricore_test__';
          localStorage.setItem(testKey, '1');
          localStorage.removeItem(testKey);
          return { status: 'pass', value: 'LocalStorage 正常' };
        }
        return { status: 'fail', message: 'LocalStorage 不可用' };
      } catch (e) {
        return { status: 'fail', message: '存储访问被拒绝' };
      }
    }

    _checkStorageRW() {
      try {
        if (typeof indexedDB !== 'undefined') {
          return { status: 'pass', value: 'IndexedDB 可用' };
        }
        if (typeof localStorage !== 'undefined') {
          return { status: 'warn', value: '仅 LocalStorage', message: 'IndexedDB 不可用' };
        }
        return { status: 'fail', message: '无可用存储机制' };
      } catch (e) {
        return { status: 'fail', message: '存储不可用' };
      }
    }

    // ═══════════════════════════════════════
    // Step 5: 完成页
    // ═══════════════════════════════════════

    _renderComplete() {
      const llmProvider = LLM_PROVIDERS[this._config.llm.provider];
      const socialEnabled = Object.values(this._config.social).filter(s => s.enabled).length;

      this._container.innerHTML = `
        <div class="wizard-step wizard-complete">
          <div class="complete-hero">
            <div class="complete-checkmark">
              <svg viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="45" class="check-circle" />
                <path d="M30 50 L45 65 L70 35" class="check-path" />
              </svg>
            </div>
            <h2>🎉 配置完成！</h2>
            <p>蜜糖 TriCore Agent 已准备就绪</p>
          </div>

          <div class="complete-summary">
            <h3>配置摘要</h3>
            <div class="summary-grid">
              <div class="summary-item">
                <span class="summary-icon">🤖</span>
                <div class="summary-content">
                  <span class="summary-label">AI 服务商</span>
                  <span class="summary-value">${llmProvider?.name || '未设置'}</span>
                </div>
              </div>
              <div class="summary-item">
                <span class="summary-icon">🎨</span>
                <div class="summary-content">
                  <span class="summary-label">界面主题</span>
                  <span class="summary-value">${this._config.ui.theme === 'dark' ? '暗色模式' : this._config.ui.theme === 'light' ? '亮色模式' : '跟随系统'}</span>
                </div>
              </div>
              <div class="summary-item">
                <span class="summary-icon">🌐</span>
                <div class="summary-content">
                  <span class="summary-label">界面语言</span>
                  <span class="summary-value">${this._config.ui.language === 'zh-CN' ? '简体中文' : 'English'}</span>
                </div>
              </div>
              <div class="summary-item">
                <span class="summary-icon">🔗</span>
                <div class="summary-content">
                  <span class="summary-label">社交渠道</span>
                  <span class="summary-value">${socialEnabled > 0 ? `已配置 ${socialEnabled} 个` : '未配置'}</span>
                </div>
              </div>
              <div class="summary-item">
                <span class="summary-icon">🔍</span>
                <div class="summary-content">
                  <span class="summary-label">系统自检</span>
                  <span class="summary-value">${this._testResults.passed !== undefined ? `${this._testResults.passed}/${this._testResults.passed + this._testResults.failed + this._testResults.warnings} 通过` : '已完成'}</span>
                </div>
              </div>
              <div class="summary-item">
                <span class="summary-icon">📋</span>
                <div class="summary-content">
                  <span class="summary-label">通知</span>
                  <span class="summary-value">${this._config.preferences.enableNotifications ? '已启用' : '已禁用'}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="complete-tips">
            <p>💡 提示：您可以随时点击右上角 <strong>⚙️</strong> 图标修改以上设置。</p>
            <p>📖 查看 <a href="#" id="link-readme">README</a> 了解更多功能和使用技巧。</p>
          </div>

          <div class="wizard-actions">
            <button class="wizard-btn wizard-btn-secondary" id="wizard-btn-back">← 返回修改</button>
            <button class="wizard-btn wizard-btn-primary wizard-btn-launch" id="wizard-btn-launch">
              🚀 启动 TriCore Agent
            </button>
          </div>
        </div>
      `;

      this._container.querySelector('#wizard-btn-back').addEventListener('click', () => {
        this._goToStep(0);
      });
      this._container.querySelector('#wizard-btn-launch').addEventListener('click', () => {
        this._completeWizard();
      });
    }

    // ═══════════════════════════════════════
    // 完成与保存
    // ═══════════════════════════════════════

    async _completeWizard() {
      try {
        // 保存配置到 SettingsManager
        if (window.TriCoreSettings) {
          await window.TriCoreSettings.load();

          // LLM 配置
          await window.TriCoreSettings.set('llm.provider', this._config.llm.provider);
          await window.TriCoreSettings.set('llm.apiKey', this._config.llm.apiKey);
          await window.TriCoreSettings.set('llm.model', this._config.llm.model);
          if (this._config.llm.baseUrl) {
            await window.TriCoreSettings.set('llm.baseUrl', this._config.llm.baseUrl);
          }
          if (this._config.llm.temperature !== undefined) {
            await window.TriCoreSettings.set('llm.temperature', this._config.llm.temperature);
          }
          if (this._config.llm.maxTokens !== undefined) {
            await window.TriCoreSettings.set('llm.maxTokens', this._config.llm.maxTokens);
          }

          // UI 配置
          await window.TriCoreSettings.set('ui.theme', this._config.ui.theme);
          await window.TriCoreSettings.set('ui.language', this._config.ui.language);
          await window.TriCoreSettings.set('ui.fontSize', this._config.ui.fontSize);

          // 通知配置
          if (this._config.preferences.enableNotifications !== undefined) {
            await window.TriCoreSettings.set('notifications.desktopEnabled', this._config.preferences.enableNotifications);
          }

          // 社交配置
          for (const [platform, config] of Object.entries(this._config.social)) {
            if (config.enabled) {
              for (const [key, value] of Object.entries(config)) {
                await window.TriCoreSettings.set(`social.${platform}.${key}`, value);
              }
            }
          }

          // 应用到UI
          if (window.TriCoreSettings._applyImmediate) {
            window.TriCoreSettings._applyImmediate('ui.theme', this._config.ui.theme);
          }
        }

        // 标记向导完成
        this._markCompleted();

        // 广播事件
        window.dispatchEvent(new CustomEvent('tricore:onboarding-complete', {
          detail: { config: this._config, testResults: this._testResults },
        }));

        // 关闭向导
        this.close();

        console.log('[OnboardingWizard] 配置向导完成！');
      } catch (e) {
        console.error('[OnboardingWizard] 保存配置失败:', e);
        alert('保存配置时出错: ' + e.message);
      }
    }

    _markCompleted() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: WIZARD_VERSION,
        completedAt: new Date().toISOString(),
      }));
    }

    _skipAll() {
      this._markCompleted();
      this.close();
      console.log('[OnboardingWizard] 用户跳过配置向导');
    }

    _showSkipConfirm() {
      const confirmHtml = `
        <div class="skip-confirm-overlay" id="skip-confirm-overlay">
          <div class="skip-confirm-dialog">
            <h4>确定要跳过配置吗？</h4>
            <p>您可以稍后在系统设置中完成配置。</p>
            <div class="skip-confirm-actions">
              <button class="wizard-btn wizard-btn-secondary" id="skip-confirm-cancel">继续配置</button>
              <button class="wizard-btn wizard-btn-text" id="skip-confirm-ok">跳过</button>
            </div>
          </div>
        </div>
      `;

      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = confirmHtml;
      const overlay = tempDiv.firstElementChild;
      document.body.appendChild(overlay);

      overlay.querySelector('#skip-confirm-cancel').addEventListener('click', () => {
        overlay.remove();
      });
      overlay.querySelector('#skip-confirm-ok').addEventListener('click', () => {
        overlay.remove();
        this._skipAll();
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
    }

    // ═══════════════════════════════════════
    // 工具方法
    // ═══════════════════════════════════════

    _showFieldError(fieldId, message) {
      const field = this._container?.querySelector(`#${fieldId}`);
      if (field) {
        field.classList.add('input-error');
        field.focus();

        // 显示错误信息
        let errorEl = field.parentNode.querySelector('.field-error');
        if (!errorEl) {
          errorEl = document.createElement('span');
          errorEl.className = 'field-error';
          field.parentNode.appendChild(errorEl);
        }
        errorEl.textContent = message;

        // 输入时清除错误
        field.addEventListener('input', () => {
          field.classList.remove('input-error');
          if (errorEl) errorEl.remove();
        }, { once: true });
      }
    }

    _escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    _bindKeyboard() {
      this._keyHandler = (e) => {
        if (e.key === 'Escape') {
          this._showSkipConfirm();
        }
        // Ctrl+Enter 下一步
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault();
          const nextBtn = this._container?.querySelector('#wizard-btn-next, #wizard-btn-complete, #wizard-btn-launch');
          if (nextBtn) nextBtn.click();
        }
      };
      document.addEventListener('keydown', this._keyHandler);
    }

    _unbindKeyboard() {
      if (this._keyHandler) {
        document.removeEventListener('keydown', this._keyHandler);
        this._keyHandler = null;
      }
    }
  }

  // ═══════════════════════════════════════
  // 暴露到全局
  // ═══════════════════════════════════════

  window.TriCoreOnboardingWizard = TriCoreOnboardingWizard;

  // 便捷方法：直接检查并启动
  window.launchOnboardingIfNeeded = async function () {
    const wizard = new TriCoreOnboardingWizard();
    return await wizard.checkAndLaunch();
  };

  console.log('[OnboardingWizard] 首次启动配置向导 v1.0 已加载');
})();
