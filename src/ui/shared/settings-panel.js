/**
 * 蜜糖 TriCore Agent — 设置面板 UI 控制器 v6.0
 *
 * 职责：
 *   1. 渲染设置面板 HTML（全屏模态框）
 *   2. 处理设置项的读写与验证
 *   3. 管理导航切换、搜索过滤、分组折叠
 *   4. Toast 提示、设置统计仪表板
 *   5. 实时预览、配置快照对比
 *   6. 键盘快捷键、批量操作
 *
 * 依赖：window.TriCoreSettings（由 settings-manager.js 提供）
 * 样式：settings-panel.css
 */

'use strict';

(function () {
  // ── 等待 SettingsManager 就绪 ──
  function waitForSettings(timeout = 5000) {
    return new Promise((resolve, reject) => {
      if (window.TriCoreSettings) {
        resolve(window.TriCoreSettings);
        return;
      }
      const start = Date.now();
      const timer = setInterval(() => {
        if (window.TriCoreSettings) {
          clearInterval(timer);
          resolve(window.TriCoreSettings);
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error('SettingsManager 未就绪'));
        }
      }, 50);
    });
  }

  // ── 全局暴露 ──
  window.TriCoreSettingsPanel = {
    _settings: null,
    _currentSection: null,
    _modifiedKeys: new Set(),
    _originalValues: {},
    _isOpen: false,
    _overlay: null,
    _dialog: null,
    _searchDebounceTimer: null,
    _snapshots: [],          // 配置快照
    _collapsedGroups: {},    // 折叠状态
    _fieldValidationErrors: {}, // 验证错误
    _globalKeyboardHandler: null,

    /**
     * 打开设置面板
     */
    async open(preselectSection = null) {
      if (this._isOpen) {
        this._focusPanel();
        if (preselectSection) this._switchSection(preselectSection);
        return;
      }

      try {
        this._settings = await waitForSettings();
        await this._settings.load();
      } catch (e) {
        console.warn('[SettingsPanel] 设置管理器未就绪，使用离线模式', e.message);
        this._settings = window.TriCoreSettings || null;
      }

      // 备份原始值用于对比
      this._captureSnapshot('打开时');

      this._render();
      this._isOpen = true;
      this._bindEvents();
      this._modifiedKeys.clear();
      this._fieldValidationErrors = {};
      this._collapsedGroups = {};

      // 切换到指定或第一个设置分类
      const schema = this._getSchema();
      if (schema && schema.length > 0) {
        const targetSection = preselectSection && schema.find(s => s.id === preselectSection)
          ? preselectSection
          : schema[0].id;
        this._switchSection(targetSection);
      }

      document.body.style.overflow = 'hidden';

      // 添加全局键盘快捷键
      this._setupGlobalShortcuts();
    },

    /**
     * 关闭设置面板
     */
    close(save = false) {
      if (!this._isOpen) return;

      if (save && this._modifiedKeys.size > 0) {
        this._showToast('设置已保存', 'success');
      }

      if (this._overlay) {
        this._overlay.classList.add('closing');
        setTimeout(() => {
          if (this._overlay) this._overlay.classList.remove('active', 'closing');
        }, 250);
      }
      this._isOpen = false;
      this._modifiedKeys.clear();
      this._fieldValidationErrors = {};
      this._snapshots = [];
      document.body.style.overflow = '';

      // 移除全局键盘处理器
      if (this._globalKeyboardHandler) {
        document.removeEventListener('keydown', this._globalKeyboardHandler);
        this._globalKeyboardHandler = null;
      }
    },

    /**
     * 切换设置面板
     */
    async toggle() {
      if (this._isOpen) {
        this.close(true);
      } else {
        await this.open();
      }
    },

    // ═══════════════════════════════════════
    // 渲染
    // ═══════════════════════════════════════

    _render() {
      // 移除已有面板
      const existing = document.getElementById('tricore-settings-overlay');
      if (existing) existing.remove();

      const schema = this._getSchema();
      const stats = this._computeStats();

      const html = `
        <div class="settings-overlay active" id="tricore-settings-overlay">
          <div class="settings-dialog" id="tricore-settings-dialog">
            <!-- 头部 -->
            <div class="settings-header">
              <div class="settings-header-left">
                <div class="settings-header-icon-wrap">
                  <span class="settings-header-icon">⚙️</span>
                </div>
                <div>
                  <h2>系统设置</h2>
                  <span class="settings-header-subtitle">蜜糖 TriCore Agent 配置中心</span>
                </div>
                <span class="settings-header-version">v6.0</span>
              </div>
              <div class="settings-header-center">
                <!-- 统计仪表板迷你版 -->
                <div class="settings-mini-stats" id="settings-mini-stats">
                  <div class="mini-stat" title="配置分类数">
                    <span class="mini-stat-icon">📂</span>
                    <span class="mini-stat-value">${stats.totalSections}</span>
                    <span class="mini-stat-label">分类</span>
                  </div>
                  <div class="mini-stat" title="配置项总数">
                    <span class="mini-stat-icon">🔧</span>
                    <span class="mini-stat-value">${stats.totalFields}</span>
                    <span class="mini-stat-label">配置项</span>
                  </div>
                  <div class="mini-stat" title="已修改项">
                    <span class="mini-stat-icon">📝</span>
                    <span class="mini-stat-value" id="mini-stat-modified">0</span>
                    <span class="mini-stat-label">已修改</span>
                  </div>
                  <div class="mini-stat" title="配置快照">
                    <span class="mini-stat-icon">📸</span>
                    <span class="mini-stat-value" id="mini-stat-snapshots">${this._snapshots.length}</span>
                    <span class="mini-stat-label">快照</span>
                  </div>
                </div>
              </div>
              <div class="settings-header-actions">
                <button class="settings-btn-header" id="settings-btn-snapshot" title="创建配置快照">📸 快照</button>
                <button class="settings-btn-header" id="settings-btn-compare" title="对比配置变更">🔍 对比</button>
                <button class="settings-btn-header" id="settings-btn-export" title="导出设置">📤 导出</button>
                <button class="settings-btn-header" id="settings-btn-import" title="导入设置">📥 导入</button>
                <button class="settings-btn-header danger" id="settings-btn-reset" title="重置所有设置">🔄 重置</button>
                <button class="settings-btn-close" id="settings-btn-close" title="关闭 (Esc)">✕</button>
              </div>
            </div>

            <!-- 主体 -->
            <div class="settings-body">
              <!-- 左侧导航 -->
              <nav class="settings-nav" id="settings-nav">
                <div class="settings-search">
                  <div class="settings-search-wrap">
                    <span class="settings-search-icon">🔍</span>
                    <input type="text" class="settings-search-input" id="settings-search"
                           placeholder="搜索设置项...">
                    <button class="settings-search-clear" id="settings-search-clear" style="display:none;">✕</button>
                  </div>
                </div>
                <div class="settings-nav-section-title">
                  <span>设置分类</span>
                  <button class="settings-nav-collapse-all" id="settings-nav-collapse-all" title="全部展开/折叠">⊞</button>
                </div>
                ${this._renderNav(schema)}
              </nav>

              <!-- 右侧内容 -->
              <div class="settings-content" id="settings-content">
                <div class="settings-welcome" id="settings-welcome">
                  <div class="settings-welcome-icon">⚙️</div>
                  <h3>蜜糖 TriCore Agent 配置中心</h3>
                  <p>从左侧导航选择要配置的设置类别，或使用搜索快速定位设置项</p>
                  <div class="settings-welcome-tips">
                    <div class="welcome-tip">
                      <span class="tip-icon">💡</span>
                      <span>修改设置后点击"保存设置"或按 <kbd>Ctrl+S</kbd> 保存</span>
                    </div>
                    <div class="welcome-tip">
                      <span class="tip-icon">🔍</span>
                      <span>使用搜索框快速过滤设置分类和配置项</span>
                    </div>
                    <div class="welcome-tip">
                      <span class="tip-icon">📸</span>
                      <span>使用快照功能记录配置状态，方便对比回滚</span>
                    </div>
                  </div>
                </div>
                <div id="settings-fields-container" style="display:none;"></div>
              </div>
            </div>

            <!-- 底部 -->
            <div class="settings-footer">
              <div class="settings-footer-left">
                <div class="settings-status" id="settings-status">
                  <span class="status-dot"></span>
                  <span id="settings-status-text">就绪</span>
                </div>
                <div class="settings-footer-shortcuts">
                  <span class="shortcut-hint"><kbd>Ctrl+S</kbd> 保存</span>
                  <span class="shortcut-hint"><kbd>Ctrl+Z</kbd> 撤销</span>
                  <span class="shortcut-hint"><kbd>Esc</kbd> 关闭</span>
                </div>
              </div>
              <div class="settings-footer-right">
                <button class="settings-btn settings-btn-secondary" id="settings-btn-undo-all" title="撤销所有修改">↩ 全部撤销</button>
                <button class="settings-btn settings-btn-secondary" id="settings-btn-cancel">取消</button>
                <button class="settings-btn settings-btn-primary" id="settings-btn-save">
                  <span class="btn-icon">💾</span>
                  <span>保存设置</span>
                  <span class="btn-badge" id="save-btn-badge" style="display:none;">0</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Toast 容器 -->
        <div id="settings-toast-container"></div>

        <!-- 快照对比弹窗 -->
        <div class="settings-compare-modal" id="settings-compare-modal" style="display:none;">
          <div class="settings-compare-dialog">
            <div class="settings-compare-header">
              <h3>📸 配置对比</h3>
              <button class="settings-btn-close" id="settings-compare-close">✕</button>
            </div>
            <div class="settings-compare-body" id="settings-compare-body">
              <p class="settings-compare-empty">暂无快照数据，请先创建配置快照</p>
            </div>
            <div class="settings-compare-footer">
              <button class="settings-btn settings-btn-secondary" id="settings-compare-cancel">关闭</button>
              <button class="settings-btn settings-btn-primary" id="settings-compare-restore" disabled>恢复到此快照</button>
            </div>
          </div>
        </div>
      `;

      document.body.insertAdjacentHTML('beforeend', html);

      this._overlay = document.getElementById('tricore-settings-overlay');
      this._dialog = document.getElementById('tricore-settings-dialog');
    },

    _renderNav(schema) {
      let html = '';
      for (const section of schema) {
        const fieldCount = this._countFields(section);
        html += `
          <div class="settings-nav-item" data-section="${section.id}">
            <span class="nav-icon">${section.icon}</span>
            <span class="nav-text">${this._stripIconPrefix(section.title)}</span>
            <span class="nav-badge nav-badge-count">${fieldCount}</span>
          </div>`;
      }
      return html;
    },

    _renderFields(sectionId) {
      const schema = this._getSchema();
      const section = schema.find(s => s.id === sectionId);
      if (!section) return '';

      let html = `
        <div class="settings-section-header">
          <div class="section-header-top">
            <h3>${section.title}</h3>
            <div class="section-header-actions">
              <button class="settings-btn-section-action" data-action="collapse-all" title="全部折叠/展开">
                ${this._areAllGroupsCollapsed(sectionId) ? '⊞ 全部展开' : '⊟ 全部折叠'}
              </button>
              <button class="settings-btn-section-action" data-action="reset-section" title="重置此分类">
                ↩ 重置
              </button>
            </div>
          </div>
          <p>${section.description}</p>
        </div>
      `;

      // 搜索高亮 - 如果搜索框有值，高亮匹配字段
      const searchQuery = document.getElementById('settings-search')?.value?.toLowerCase() || '';

      for (const group of section.groups) {
        const isCollapsed = this._collapsedGroups[sectionId + '::' + group.id];
        const matchingFields = searchQuery
          ? group.fields.filter(f =>
              f.label.toLowerCase().includes(searchQuery) ||
              f.key.toLowerCase().includes(searchQuery) ||
              (f.description && f.description.toLowerCase().includes(searchQuery)))
          : group.fields;

        html += `<div class="settings-group ${isCollapsed ? 'collapsed' : ''}" data-group-id="${sectionId}::${group.id}">`;
        html += `<div class="settings-group-title" data-toggle-group="${sectionId}::${group.id}">`;
        html += `<span class="group-toggle-icon">${isCollapsed ? '▶' : '▼'}</span>`;
        html += `<span>${group.title || ''}</span>`;
        html += `<span class="group-field-count">${group.fields.length}项</span>`;
        html += `</div>`;
        html += `<div class="settings-group-body" ${isCollapsed ? 'style="display:none;"' : ''}>`;
        for (const field of group.fields) {
          const highlightClass = searchQuery && (field.label.toLowerCase().includes(searchQuery) ||
            field.key.toLowerCase().includes(searchQuery) ||
            (field.description && field.description.toLowerCase().includes(searchQuery)))
            ? 'search-highlight' : '';
          html += `<div class="settings-field ${highlightClass}" data-field-key="${field.key}">`;
          html += this._renderField(field);
          html += `</div>`;
        }
        html += `</div></div>`;
      }

      // 配置差异统计面板
      html += `
        <div class="settings-group settings-stats-panel">
          <div class="settings-group-title">
            <span class="group-toggle-icon">📊</span>
            <span>分类统计</span>
          </div>
          <div class="settings-stats-grid">
            <div class="stat-card">
              <div class="stat-card-value" id="stat-modified-count">0</div>
              <div class="stat-card-label">本分类已修改</div>
            </div>
            <div class="stat-card">
              <div class="stat-card-value" id="stat-total-count">${this._countFields(section)}</div>
              <div class="stat-card-label">配置项总数</div>
            </div>
            <div class="stat-card">
              <div class="stat-card-value" id="stat-unchanged-count">${this._countFields(section)}</div>
              <div class="stat-card-label">未修改项</div>
            </div>
            <div class="stat-card">
              <div class="stat-card-value" id="stat-validation-errors">0</div>
              <div class="stat-card-label">验证错误</div>
            </div>
          </div>
        </div>
      `;

      // 导入区域（始终渲染但隐藏）
      html += `
        <div class="settings-group settings-import-export" style="display:none;" id="settings-import-area">
          <div class="settings-group-title">
            <span class="group-toggle-icon">📥</span>
            <span>导入配置</span>
          </div>
          <textarea class="settings-textarea" id="settings-import-text"
                    placeholder="粘贴JSON配置内容..."></textarea>
          <div class="settings-import-actions">
            <label class="settings-import-option">
              <input type="checkbox" id="settings-import-merge" checked>
              <span>合并模式（保留未导入的现有设置）</span>
            </label>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button class="settings-btn settings-btn-secondary" id="settings-btn-cancel-import">取消</button>
              <button class="settings-btn settings-btn-primary" id="settings-btn-confirm-import">确认导入</button>
            </div>
          </div>
        </div>
      `;

      return html;
    },

    _renderField(field) {
      const currentValue = this._settings ? this._settings.get(field.key) : field.default;
      const displayValue = currentValue !== undefined ? currentValue : field.default;
      const validationError = this._fieldValidationErrors[field.key];
      const isRequired = field.required === true;

      let controlHtml = '';
      switch (field.type) {
        case 'select':
          controlHtml = `
            <select class="settings-select ${validationError ? 'has-error' : ''}" data-key="${field.key}" data-default="${field.default}">
              ${(field.options || []).map(o => `
                <option value="${o.value}" ${String(displayValue) === String(o.value) ? 'selected' : ''}>${o.label}</option>
              `).join('')}
            </select>`;
          break;

        case 'password':
          controlHtml = `
            <div class="settings-password-wrap">
              <input type="password" class="settings-input-password ${validationError ? 'has-error' : ''}" data-key="${field.key}"
                     data-default="${field.default}" placeholder="${field.placeholder || ''}"
                     value="${this._maskValue(displayValue)}" data-real-value="${this._escapeAttr(displayValue)}">
              <button class="settings-password-toggle" data-target="${field.key}" title="显示/隐藏">👁</button>
              ${isRequired ? '<span class="field-required">*</span>' : ''}
            </div>`;
          break;

        case 'toggle':
          controlHtml = `
            <label class="settings-toggle">
              <input type="checkbox" data-key="${field.key}" data-default="${field.default}"
                     ${displayValue ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label">${displayValue ? '已启用' : '已禁用'}</span>`;
          break;

        case 'range':
          controlHtml = `
            <div class="settings-range-wrap">
              <input type="range" class="settings-range" data-key="${field.key}"
                     data-default="${field.default}" min="${field.min}" max="${field.max}"
                     step="${field.step}" value="${displayValue}">
              <span class="settings-range-value">${displayValue}${field.unit || ''}</span>
            </div>`;
          break;

        case 'number':
          controlHtml = `
            <div class="settings-number-wrap">
              <input type="number" class="settings-input settings-number ${validationError ? 'has-error' : ''}" data-key="${field.key}"
                     data-default="${field.default}" min="${field.min || ''}" max="${field.max || ''}"
                     step="${field.step || 1}" value="${displayValue}">
              ${field.unit ? `<span class="settings-number-unit">${field.unit}</span>` : ''}
              ${isRequired ? '<span class="field-required">*</span>' : ''}
            </div>`;
          break;

        case 'tags':
          const tags = typeof displayValue === 'string'
            ? displayValue.split(',').map(t => t.trim()).filter(Boolean)
            : (Array.isArray(displayValue) ? displayValue : []);
          controlHtml = `
            <div class="settings-tags ${validationError ? 'has-error' : ''}" data-key="${field.key}" data-default="${field.default}">
              ${tags.map(t => `
                <span class="settings-tag">
                  ${this._escapeHtml(t)}
                  <span class="tag-remove" data-tag="${this._escapeAttr(t)}">×</span>
                </span>
              `).join('')}
              <input type="text" class="settings-tags-input" placeholder="${field.placeholder || '添加后按回车...'}">
            </div>`;
          break;

        case 'color':
          controlHtml = `
            <div class="settings-color-wrap">
              <input type="color" class="settings-color" data-key="${field.key}"
                     data-default="${field.default}" value="${displayValue}">
              <input type="text" class="settings-input settings-color-text" data-key="${field.key}"
                     data-default="${field.default}" value="${displayValue}" maxlength="7">
            </div>`;
          break;

        case 'textarea':
          controlHtml = `
            <textarea class="settings-textarea settings-textarea-field ${validationError ? 'has-error' : ''}"
                      data-key="${field.key}" data-default="${field.default}"
                      placeholder="${field.placeholder || ''}"
                      rows="${field.rows || 3}">${this._escapeHtml(String(displayValue || ''))}</textarea>`;
          break;

        case 'keybinding':
          controlHtml = `
            <div class="settings-keybinding" data-key="${field.key}" data-default="${field.default}">
              <input type="text" class="settings-input settings-keybinding-input" data-key="${field.key}"
                     data-default="${field.default}" placeholder="点击后按键录制..."
                     value="${this._escapeHtml(String(displayValue || ''))}" readonly>
              <button class="settings-keybinding-record" title="录制快捷键">🎹</button>
              <button class="settings-keybinding-clear" title="清除快捷键">✕</button>
            </div>`;
          break;

        case 'text':
        default:
          controlHtml = `
            <input type="text" class="settings-input ${validationError ? 'has-error' : ''}" data-key="${field.key}"
                   data-default="${field.default}" placeholder="${field.placeholder || ''}"
                   value="${this._escapeAttr(String(displayValue || ''))}">
            ${isRequired ? '<span class="field-required">*</span>' : ''}`;
          break;
      }

      const modifiedClass = this._modifiedKeys.has(field.key) ? 'modified' : '';
      const errorClass = validationError ? 'has-validation-error' : '';

      return `
        <div class="settings-field-label">
          <label>${field.label}${isRequired ? ' <span class="label-required">*</span>' : ''}</label>
          ${field.description ? `<span class="field-desc">${field.description}</span>` : ''}
          ${validationError ? `<span class="field-error-msg">${validationError}</span>` : ''}
        </div>
        <div class="settings-field-control">
          ${controlHtml}
          <button class="settings-field-reset" data-key="${field.key}" data-default="${field.default}"
                  title="恢复默认值" ${!this._modifiedKeys.has(field.key) ? 'style="visibility:hidden;"' : ''}>↩</button>
        </div>
      `;
    },

    // ═══════════════════════════════════════
    // 事件绑定
    // ═══════════════════════════════════════

    _bindEvents() {
      // 关闭
      document.getElementById('settings-btn-close').addEventListener('click', () => this.close(true));
      document.getElementById('settings-btn-cancel').addEventListener('click', () => this.close(false));

      // 保存
      document.getElementById('settings-btn-save').addEventListener('click', () => this._saveAll());

      // 全部撤销
      document.getElementById('settings-btn-undo-all').addEventListener('click', () => this._undoAll());

      // 重置
      document.getElementById('settings-btn-reset').addEventListener('click', () => this._confirmReset());

      // 快照
      document.getElementById('settings-btn-snapshot').addEventListener('click', () => this._createSnapshot());

      // 对比
      document.getElementById('settings-btn-compare').addEventListener('click', () => this._openCompareModal());

      // 导出
      document.getElementById('settings-btn-export').addEventListener('click', () => this._exportConfig());

      // 导入
      document.getElementById('settings-btn-import').addEventListener('click', () => this._showImportArea());

      // 导航切换
      this._overlay.querySelectorAll('.settings-nav-item').forEach(item => {
        item.addEventListener('click', () => {
          const sectionId = item.dataset.section;
          this._switchSection(sectionId);
        });
      });

      // 导航全部折叠/展开
      document.getElementById('settings-nav-collapse-all').addEventListener('click', () => {
        this._toggleAllNavCollapse();
      });

      // 搜索
      const searchInput = document.getElementById('settings-search');
      searchInput.addEventListener('input', () => {
        clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = setTimeout(() => {
          this._filterNav(searchInput.value);
          // 同时高亮当前分类字段
          if (this._currentSection) {
            this._switchSection(this._currentSection);
          }
        }, 200);
      });

      // 搜索清除
      document.getElementById('settings-search-clear').addEventListener('click', () => {
        searchInput.value = '';
        searchInput.focus();
        this._filterNav('');
        if (this._currentSection) this._switchSection(this._currentSection);
      });

      // 点击覆盖层关闭
      this._overlay.addEventListener('click', (e) => {
        if (e.target === this._overlay) {
          this.close(true);
        }
      });

      // 字段变更监听（事件委托）
      document.getElementById('settings-content').addEventListener('change', (e) => {
        const key = e.target.dataset.key;
        if (key) {
          this._onFieldChanged(key, e.target);
        }
      });

      document.getElementById('settings-content').addEventListener('input', (e) => {
        const key = e.target.dataset.key;
        if (key && (e.target.type === 'range' || e.target.type === 'number' || e.target.classList.contains('settings-color-text'))) {
          this._onFieldChanged(key, e.target);
        }
      });

      // 各种点击事件
      document.getElementById('settings-content').addEventListener('click', (e) => {
        // 分组折叠切换
        if (e.target.closest('[data-toggle-group]')) {
          const groupId = e.target.closest('[data-toggle-group]').dataset.toggleGroup;
          this._toggleGroup(groupId);
          return;
        }

        // 分组操作
        if (e.target.closest('[data-action]')) {
          const action = e.target.closest('[data-action]').dataset.action;
          if (action === 'collapse-all') this._toggleAllGroups();
          if (action === 'reset-section') this._resetCurrentSection();
          return;
        }

        // 密码显示切换
        if (e.target.classList.contains('settings-password-toggle')) {
          const targetKey = e.target.dataset.target;
          const input = document.querySelector(`input[data-key="${targetKey}"]`);
          if (input) {
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            e.target.textContent = isPassword ? '🙈' : '👁';
            if (isPassword) {
              input.value = input.dataset.realValue || '';
            } else {
              input.dataset.realValue = input.value;
              input.value = this._maskValue(input.dataset.realValue || '');
            }
          }
        }

        // 标签删除
        if (e.target.classList.contains('tag-remove')) {
          const tag = e.target.dataset.tag;
          const tagsContainer = e.target.closest('.settings-tags');
          if (tagsContainer) {
            e.target.parentElement.remove();
            this._onTagsChanged(tagsContainer);
          }
        }

        // 字段重置
        if (e.target.classList.contains('settings-field-reset')) {
          const key = e.target.dataset.key;
          const defaultVal = e.target.dataset.default;
          this._resetField(key, defaultVal);
        }

        // 快捷键录制
        if (e.target.classList.contains('settings-keybinding-record')) {
          const wrap = e.target.closest('.settings-keybinding');
          const input = wrap.querySelector('.settings-keybinding-input');
          this._startKeybindingRecord(input);
        }

        // 快捷键清除
        if (e.target.classList.contains('settings-keybinding-clear')) {
          const wrap = e.target.closest('.settings-keybinding');
          const input = wrap.querySelector('.settings-keybinding-input');
          input.value = '';
          this._onFieldChanged(input.dataset.key, input);
        }
      });

      // 标签输入回车添加
      document.getElementById('settings-content').addEventListener('keydown', (e) => {
        if (e.target.classList.contains('settings-tags-input') && e.key === 'Enter') {
          e.preventDefault();
          const value = e.target.value.trim();
          if (value) {
            const tagsContainer = e.target.closest('.settings-tags');
            const inputEl = e.target;
            const tagHtml = `<span class="settings-tag">${this._escapeHtml(value)}<span class="tag-remove" data-tag="${this._escapeAttr(value)}">×</span></span>`;
            inputEl.insertAdjacentHTML('beforebegin', tagHtml);
            inputEl.value = '';
            this._onTagsChanged(tagsContainer);
          }
        }
      });

      // 对比弹窗事件
      document.getElementById('settings-compare-close').addEventListener('click', () => this._closeCompareModal());
      document.getElementById('settings-compare-cancel').addEventListener('click', () => this._closeCompareModal());
      document.getElementById('settings-compare-restore').addEventListener('click', () => this._restoreSnapshot());
    },

    _setupGlobalShortcuts() {
      this._globalKeyboardHandler = (e) => {
        // Ctrl+S 保存
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          this._saveAll();
          return;
        }
        // Ctrl+Z 撤销
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          this._undoAll();
          return;
        }
        // Esc 关闭
        if (e.key === 'Escape') {
          // 检查对比弹窗是否打开
          const compareModal = document.getElementById('settings-compare-modal');
          if (compareModal && compareModal.style.display !== 'none') {
            this._closeCompareModal();
            return;
          }
          this.close(true);
        }
      };
      document.addEventListener('keydown', this._globalKeyboardHandler);
    },

    // ═══════════════════════════════════════
    // 设置操作
    // ═══════════════════════════════════════

    _switchSection(sectionId) {
      this._currentSection = sectionId;

      // 更新导航高亮
      this._overlay.querySelectorAll('.settings-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.section === sectionId);
      });

      // 隐藏欢迎，显示内容
      const welcome = document.getElementById('settings-welcome');
      const container = document.getElementById('settings-fields-container');
      if (welcome) welcome.style.display = 'none';
      if (container) {
        container.style.display = '';
        container.innerHTML = this._renderFields(sectionId);
      }

      // 更新统计面板
      setTimeout(() => this._updateStatsPanel(), 50);

      // 滚动到顶部
      document.getElementById('settings-content').scrollTop = 0;
    },

    _toggleGroup(groupId) {
      this._collapsedGroups[groupId] = !this._collapsedGroups[groupId];
      const groupEl = document.querySelector(`[data-group-id="${groupId}"]`);
      if (groupEl) {
        groupEl.classList.toggle('collapsed', this._collapsedGroups[groupId]);
        const body = groupEl.querySelector('.settings-group-body');
        const icon = groupEl.querySelector('.group-toggle-icon');
        if (body) body.style.display = this._collapsedGroups[groupId] ? 'none' : '';
        if (icon) icon.textContent = this._collapsedGroups[groupId] ? '▶' : '▼';
      }
    },

    _toggleAllGroups() {
      const section = this._getSchema().find(s => s.id === this._currentSection);
      if (!section) return;
      const allCollapsed = this._areAllGroupsCollapsed(this._currentSection);
      for (const group of section.groups) {
        this._collapsedGroups[this._currentSection + '::' + group.id] = !allCollapsed;
      }
      // 重新渲染
      this._switchSection(this._currentSection);
    },

    _toggleAllNavCollapse() {
      // 展开所有折叠组
      const hasCollapsed = Object.values(this._collapsedGroups).some(v => v);
      if (hasCollapsed) {
        this._collapsedGroups = {};
      } else {
        const schema = this._getSchema();
        for (const section of schema) {
          for (const group of section.groups) {
            this._collapsedGroups[section.id + '::' + group.id] = true;
          }
        }
      }
      if (this._currentSection) this._switchSection(this._currentSection);
    },

    _areAllGroupsCollapsed(sectionId) {
      const section = this._getSchema().find(s => s.id === sectionId);
      if (!section) return false;
      return section.groups.every(g => this._collapsedGroups[sectionId + '::' + g.id]);
    },

    _onFieldChanged(key, element) {
      const fieldEl = element.closest('.settings-field');
      let newValue;

      if (element.type === 'checkbox') {
        newValue = element.checked;
        // 更新toggle-label
        const label = element.closest('.settings-field-control')?.querySelector('.toggle-label');
        if (label) label.textContent = newValue ? '已启用' : '已禁用';
      } else if (element.type === 'range') {
        newValue = parseFloat(element.value);
        const valueSpan = element.parentElement.querySelector('.settings-range-value');
        if (valueSpan) {
          valueSpan.textContent = newValue + (valueSpan.textContent.match(/[^\d.]+$/) || [''])[0];
        }
      } else if (element.type === 'number') {
        newValue = element.step && parseFloat(element.step) < 1 ? parseFloat(element.value) : parseInt(element.value, 10);
      } else if (element.type === 'color') {
        newValue = element.value;
        const colorText = element.closest('.settings-color-wrap')?.querySelector('.settings-color-text');
        if (colorText && element === colorText) {
          const colorPicker = element.closest('.settings-color-wrap')?.querySelector('.settings-color');
          if (colorPicker) colorPicker.value = newValue;
        } else {
          const textInput = element.closest('.settings-color-wrap')?.querySelector('.settings-color-text');
          if (textInput) textInput.value = newValue;
        }
      } else if (element.tagName === 'TEXTAREA') {
        newValue = element.value;
      } else {
        newValue = element.value;
      }

      // 验证
      this._validateField(key, newValue);

      // 比较是否修改
      const defaultVal = element.dataset.default;
      const defaultValue = element.type === 'checkbox'
        ? (defaultVal === 'true')
        : (element.type === 'range' || element.type === 'number'
          ? parseFloat(defaultVal)
          : defaultVal);

      const isModified = String(newValue) !== String(defaultValue);

      if (isModified) {
        this._modifiedKeys.add(key);
        if (fieldEl) fieldEl.classList.add('modified');
      } else {
        this._modifiedKeys.delete(key);
        if (fieldEl) fieldEl.classList.remove('modified');
      }

      // 显示/隐藏重置按钮
      if (fieldEl) {
        const resetBtn = fieldEl.querySelector('.settings-field-reset');
        if (resetBtn) resetBtn.style.visibility = isModified ? '' : 'hidden';
      }

      this._updateModifiedBadge();
      this._updateStatsPanel();
    },

    _onTagsChanged(container) {
      const key = container.dataset.key;
      const tags = Array.from(container.querySelectorAll('.settings-tag'))
        .map(el => el.textContent.replace('×', '').trim());
      const newValue = tags.join(',');

      const defaultVal = container.dataset.default || '';
      const isModified = newValue !== defaultVal;

      if (isModified) {
        this._modifiedKeys.add(key);
        container.closest('.settings-field')?.classList.add('modified');
      } else {
        this._modifiedKeys.delete(key);
        container.closest('.settings-field')?.classList.remove('modified');
      }

      // 显示/隐藏重置按钮
      const resetBtn = container.closest('.settings-field')?.querySelector('.settings-field-reset');
      if (resetBtn) resetBtn.style.visibility = isModified ? '' : 'hidden';

      this._updateModifiedBadge();
      this._updateStatsPanel();
    },

    _resetField(key, defaultValue) {
      this._modifiedKeys.delete(key);
      const fieldEl = document.querySelector(`[data-field-key="${key}"]`);
      if (fieldEl) {
        fieldEl.classList.remove('modified');
        const resetBtn = fieldEl.querySelector('.settings-field-reset');
        if (resetBtn) resetBtn.style.visibility = 'hidden';
      }

      // 找到对应控件并重置
      const control = document.querySelector(`[data-key="${key}"]`);
      if (control) {
        if (control.type === 'checkbox') {
          control.checked = defaultValue === 'true';
          const label = control.closest('.settings-field-control')?.querySelector('.toggle-label');
          if (label) label.textContent = control.checked ? '已启用' : '已禁用';
        } else if (control.classList.contains('settings-tags')) {
          control.querySelectorAll('.settings-tag').forEach(t => t.remove());
          if (defaultValue) {
            const tags = defaultValue.split(',');
            const inputEl = control.querySelector('.settings-tags-input');
            tags.forEach(t => {
              const tagHtml = `<span class="settings-tag">${this._escapeHtml(t.trim())}<span class="tag-remove" data-tag="${this._escapeAttr(t.trim())}">×</span></span>`;
              if (inputEl) inputEl.insertAdjacentHTML('beforebegin', tagHtml);
            });
          }
        } else {
          control.value = defaultValue;
          if (control.type === 'range') {
            const valueSpan = control.parentElement.querySelector('.settings-range-value');
            if (valueSpan) valueSpan.textContent = defaultValue + (valueSpan.textContent.match(/[^\d.]+$/) || [''])[0];
          }
        }
      }

      this._updateModifiedBadge();
      this._updateStatsPanel();
      this._showToast('已恢复默认值', 'info');
    },

    _undoAll() {
      if (this._modifiedKeys.size === 0) {
        this._showToast('没有需要撤销的修改', 'info');
        return;
      }
      const keys = [...this._modifiedKeys];
      for (const key of keys) {
        const control = document.querySelector(`[data-key="${key}"]`);
        if (control) {
          this._resetField(key, control.dataset.default);
        }
      }
      this._modifiedKeys.clear();
      this._updateModifiedBadge();
      this._updateStatsPanel();
      this._showToast(`已撤销 ${keys.length} 项修改`, 'info');
    },

    _updateModifiedBadge() {
      const statusText = document.getElementById('settings-status-text');
      const badge = document.getElementById('save-btn-badge');
      const count = this._modifiedKeys.size;

      if (statusText) {
        if (count > 0) {
          statusText.textContent = `${count} 项已修改`;
          statusText.style.color = 'var(--accent-yellow)';
        } else {
          statusText.textContent = '就绪';
          statusText.style.color = '';
        }
      }
      if (badge) {
        if (count > 0) {
          badge.style.display = '';
          badge.textContent = count;
        } else {
          badge.style.display = 'none';
        }
      }

      // 更新迷你统计
      const miniStat = document.getElementById('mini-stat-modified');
      if (miniStat) miniStat.textContent = count;
    },

    _updateStatsPanel() {
      const section = this._getSchema().find(s => s.id === this._currentSection);
      if (!section) return;

      const totalFields = this._countFields(section);
      const sectionKeys = this._getSectionKeys(section);
      const modifiedInSection = sectionKeys.filter(k => this._modifiedKeys.has(k)).length;
      const validationErrors = sectionKeys.filter(k => this._fieldValidationErrors[k]).length;

      const elModified = document.getElementById('stat-modified-count');
      const elTotal = document.getElementById('stat-total-count');
      const elUnchanged = document.getElementById('stat-unchanged-count');
      const elErrors = document.getElementById('stat-validation-errors');

      if (elModified) elModified.textContent = modifiedInSection;
      if (elTotal) elTotal.textContent = totalFields;
      if (elUnchanged) elUnchanged.textContent = totalFields - modifiedInSection;
      if (elErrors) elErrors.textContent = validationErrors;

      // 错误状态样式
      if (elErrors) elErrors.style.color = validationErrors > 0 ? 'var(--accent-red)' : '';
    },

    _validateField(key, value) {
      // 简单验证逻辑
      const field = this._findFieldSchema(key);
      if (!field) return;

      let error = null;
      if (field.required && (!value || value === '')) {
        error = '此项为必填';
      }
      if (field.min !== undefined && parseFloat(value) < field.min) {
        error = `最小值: ${field.min}`;
      }
      if (field.max !== undefined && parseFloat(value) > field.max) {
        error = `最大值: ${field.max}`;
      }
      if (field.pattern && !new RegExp(field.pattern).test(value)) {
        error = '格式不正确';
      }

      if (error) {
        this._fieldValidationErrors[key] = error;
      } else {
        delete this._fieldValidationErrors[key];
      }

      // 更新UI
      const fieldEl = document.querySelector(`[data-field-key="${key}"]`);
      if (fieldEl) {
        fieldEl.classList.toggle('has-validation-error', !!error);
        const errMsg = fieldEl.querySelector('.field-error-msg');
        if (errMsg) errMsg.textContent = error || '';
      }
    },

    async _saveAll() {
      if (!this._settings) {
        this._showToast('设置管理器未就绪', 'error');
        return;
      }

      // 检查验证错误
      if (Object.keys(this._fieldValidationErrors).length > 0) {
        this._showToast(`请修正 ${Object.keys(this._fieldValidationErrors).length} 个验证错误后再保存`, 'error');
        return;
      }

      const statusEl = document.getElementById('settings-status');
      if (statusEl) statusEl.classList.add('saving');
      document.getElementById('settings-status-text').textContent = '保存中...';

      const saveBtn = document.getElementById('settings-btn-save');
      if (saveBtn) saveBtn.disabled = true;

      try {
        const content = document.getElementById('settings-content');
        const allInputs = content.querySelectorAll('[data-key]');

        const pairs = [];
        const seenKeys = new Set();
        for (const input of allInputs) {
          const key = input.dataset.key;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          let value;
          if (input.type === 'checkbox') {
            value = input.checked;
          } else if (input.type === 'range' || input.type === 'number') {
            value = input.step && parseFloat(input.step) < 1
              ? parseFloat(input.value)
              : parseInt(input.value, 10);
          } else if (input.classList.contains('settings-tags')) {
            const tags = Array.from(input.querySelectorAll('.settings-tag'))
              .map(el => el.textContent.replace('×', '').trim());
            value = tags;
          } else if (input.tagName === 'TEXTAREA') {
            value = input.value;
          } else if (input.classList.contains('settings-keybinding-input')) {
            value = input.value;
          } else if (input.type === 'color') {
            value = input.value;
          } else {
            value = input.value;
          }
          pairs.push([key, value]);
        }

        await this._settings.setMultiple(pairs);
        this._modifiedKeys.clear();
        this._fieldValidationErrors = {};
        this._updateModifiedBadge();
        document.getElementById('settings-status-text').textContent = '已保存';
        if (statusEl) statusEl.classList.add('success');

        // 创建保存后快照
        this._captureSnapshot('保存后');

        this._showToast('✅ 设置已保存并生效', 'success');

        // 刷新所有字段的修改状态
        content.querySelectorAll('[data-key]').forEach(el => {
          if (el.type === 'checkbox') {
            el.dataset.default = String(el.checked);
          } else if (el.classList.contains('settings-tags')) {
            const tags = Array.from(el.querySelectorAll('.settings-tag'))
              .map(t => t.textContent.replace('×', '').trim()).join(',');
            el.dataset.default = tags;
          } else {
            el.dataset.default = el.value;
          }
        });
        content.querySelectorAll('.settings-field.modified').forEach(el => {
          el.classList.remove('modified');
        });
        content.querySelectorAll('.settings-field-reset').forEach(btn => {
          btn.style.visibility = 'hidden';
        });

        this._updateStatsPanel();

      } catch (e) {
        this._showToast('保存失败: ' + e.message, 'error');
        document.getElementById('settings-status-text').textContent = '保存失败';
        if (statusEl) statusEl.classList.add('error');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
        if (statusEl) {
          statusEl.classList.remove('saving');
          setTimeout(() => {
            statusEl.classList.remove('success', 'error');
            document.getElementById('settings-status-text').textContent = '就绪';
            if (statusEl) statusEl.style.color = '';
          }, 2000);
        }
      }
    },

    async _confirmReset() {
      if (confirm('确定要重置所有设置为默认值吗？\n\n此操作将清除所有自定义配置，恢复到出厂默认值。此操作不可撤销。')) {
        try {
          if (this._settings) {
            await this._settings.resetAll();
          }
          this._modifiedKeys.clear();
          this._fieldValidationErrors = {};
          this._updateModifiedBadge();

          // 重新渲染当前分类
          if (this._currentSection) {
            this._switchSection(this._currentSection);
          }

          this._showToast('🔄 设置已重置为默认值', 'info');
        } catch (e) {
          this._showToast('重置失败: ' + e.message, 'error');
        }
      }
    },

    async _resetCurrentSection() {
      if (!this._currentSection) return;
      const section = this._getSchema().find(s => s.id === this._currentSection);
      if (!section) return;

      if (!confirm(`确定要重置"${this._stripIconPrefix(section.title)}"分类的所有设置吗？`)) return;

      const keys = this._getSectionKeys(section);
      for (const key of keys) {
        const control = document.querySelector(`[data-key="${key}"]`);
        if (control) {
          this._resetField(key, control.dataset.default);
        }
      }
      this._showToast(`已重置"${this._stripIconPrefix(section.title)}"分类`, 'info');
    },

    // ═══════════════════════════════════════
    // 配置快照与对比
    // ═══════════════════════════════════════

    _captureSnapshot(label = '') {
      const timestamp = new Date().toISOString();
      const data = {};
      const allInputs = document.querySelectorAll('#settings-content [data-key]');
      const seen = new Set();
      for (const input of allInputs) {
        const key = input.dataset.key;
        if (seen.has(key)) continue;
        seen.add(key);
        if (input.type === 'checkbox') {
          data[key] = input.checked;
        } else if (input.classList.contains('settings-tags')) {
          data[key] = Array.from(input.querySelectorAll('.settings-tag'))
            .map(el => el.textContent.replace('×', '').trim());
        } else {
          data[key] = input.value;
        }
      }

      this._snapshots.push({
        label: label || `快照 ${this._snapshots.length + 1}`,
        timestamp,
        data,
        modifiedCount: this._modifiedKeys.size,
        section: this._currentSection,
      });

      // 最多保留10个快照
      if (this._snapshots.length > 10) {
        this._snapshots.shift();
      }

      // 更新迷你统计
      const miniStat = document.getElementById('mini-stat-snapshots');
      if (miniStat) miniStat.textContent = this._snapshots.length;

      this._showToast(`📸 配置快照已创建: ${label || '快照'}`, 'success');
    },

    _openCompareModal() {
      const modal = document.getElementById('settings-compare-modal');
      const body = document.getElementById('settings-compare-body');

      if (this._snapshots.length === 0) {
        body.innerHTML = `
          <div class="settings-compare-empty">
            <div class="compare-empty-icon">📸</div>
            <p>暂无配置快照</p>
            <p class="compare-empty-hint">请先在设置页面中点击"快照"按钮创建配置快照</p>
            <button class="settings-btn settings-btn-primary" id="settings-compare-create-first">立即创建快照</button>
          </div>`;
        document.getElementById('settings-compare-create-first').addEventListener('click', () => {
          this._captureSnapshot('手动快照');
          this._openCompareModal();
        });
      } else {
        // 当前值
        const currentData = {};
        const allInputs = document.querySelectorAll('#settings-content [data-key]');
        const seen = new Set();
        for (const input of allInputs) {
          const key = input.dataset.key;
          if (seen.has(key)) continue;
          seen.add(key);
          if (input.type === 'checkbox') {
            currentData[key] = input.checked;
          } else if (input.classList.contains('settings-tags')) {
            currentData[key] = Array.from(input.querySelectorAll('.settings-tag'))
              .map(el => el.textContent.replace('×', '').trim());
          } else {
            currentData[key] = input.value;
          }
        }

        let html = '<div class="compare-snapshots-list">';
        this._snapshots.slice().reverse().forEach((snap, idx) => {
          const realIdx = this._snapshots.length - 1 - idx;
          const diffCount = this._computeDiff(currentData, snap.data);
          const date = new Date(snap.timestamp);
          html += `
            <div class="compare-snapshot-item" data-snapshot-index="${realIdx}">
              <div class="compare-snapshot-radio">
                <input type="radio" name="compare-snapshot" value="${realIdx}">
              </div>
              <div class="compare-snapshot-info">
                <div class="compare-snapshot-label">${snap.label}</div>
                <div class="compare-snapshot-meta">
                  ${date.toLocaleString('zh-CN')} · ${diffCount} 项差异
                </div>
              </div>
              <div class="compare-snapshot-badge ${diffCount > 0 ? 'has-diff' : 'no-diff'}">
                ${diffCount > 0 ? `${diffCount} 差异` : '无差异'}
              </div>
            </div>`;
        });
        html += '</div>';

        // 差异详情
        html += '<div class="compare-diff-detail" id="compare-diff-detail"></div>';

        body.innerHTML = html;

        // 绑定选择事件
        body.querySelectorAll('input[name="compare-snapshot"]').forEach(radio => {
          radio.addEventListener('change', () => {
            const idx = parseInt(radio.value);
            this._showDiffDetail(idx, currentData);
            document.getElementById('settings-compare-restore').disabled = false;
          });
        });
      }

      modal.style.display = 'flex';
      document.getElementById('settings-compare-restore').disabled = true;
    },

    _closeCompareModal() {
      document.getElementById('settings-compare-modal').style.display = 'none';
    },

    _showDiffDetail(snapshotIdx, currentData) {
      const detail = document.getElementById('compare-diff-detail');
      if (!detail) return;

      const snapshot = this._snapshots[snapshotIdx];
      if (!snapshot) return;

      const diffs = [];
      const allKeys = new Set([...Object.keys(currentData), ...Object.keys(snapshot.data)]);
      for (const key of allKeys) {
        const cur = JSON.stringify(currentData[key]);
        const old = JSON.stringify(snapshot.data[key]);
        if (cur !== old) {
          const field = this._findFieldSchema(key);
          diffs.push({
            key,
            label: field ? field.label : key,
            current: currentData[key],
            snapshot: snapshot.data[key],
          });
        }
      }

      if (diffs.length === 0) {
        detail.innerHTML = '<div class="compare-no-diff">✅ 当前配置与此快照完全一致</div>';
        return;
      }

      let html = `<div class="compare-diff-header">发现 ${diffs.length} 项差异</div>`;
      html += '<div class="compare-diff-table">';
      for (const diff of diffs) {
        html += `
          <div class="compare-diff-row">
            <div class="diff-key">${diff.label} <code>${diff.key}</code></div>
            <div class="diff-values">
              <div class="diff-old">
                <span class="diff-label">快照值:</span>
                <span class="diff-val-old">${this._formatDiffValue(diff.snapshot)}</span>
              </div>
              <div class="diff-arrow">→</div>
              <div class="diff-new">
                <span class="diff-label">当前值:</span>
                <span class="diff-val-new">${this._formatDiffValue(diff.current)}</span>
              </div>
            </div>
          </div>`;
      }
      html += '</div>';
      detail.innerHTML = html;
    },

    _restoreSnapshot() {
      const selected = document.querySelector('input[name="compare-snapshot"]:checked');
      if (!selected) return;

      const idx = parseInt(selected.value);
      const snapshot = this._snapshots[idx];
      if (!snapshot) return;

      if (!confirm(`确定要恢复到此快照吗？\n\n快照: ${snapshot.label}\n时间: ${new Date(snapshot.timestamp).toLocaleString('zh-CN')}\n\n恢复后当前所有未保存的修改将被覆盖。`)) return;

      for (const [key, value] of Object.entries(snapshot.data)) {
        const control = document.querySelector(`[data-key="${key}"]`);
        if (control) {
          if (control.type === 'checkbox') {
            control.checked = value;
            const label = control.closest('.settings-field-control')?.querySelector('.toggle-label');
            if (label) label.textContent = value ? '已启用' : '已禁用';
          } else if (control.classList.contains('settings-tags')) {
            control.querySelectorAll('.settings-tag').forEach(t => t.remove());
            const inputEl = control.querySelector('.settings-tags-input');
            (Array.isArray(value) ? value : []).forEach(t => {
              const tagHtml = `<span class="settings-tag">${this._escapeHtml(t)}<span class="tag-remove" data-tag="${this._escapeAttr(t)}">×</span></span>`;
              if (inputEl) inputEl.insertAdjacentHTML('beforebegin', tagHtml);
            });
          } else {
            control.value = value;
            if (control.type === 'range') {
              const valueSpan = control.parentElement.querySelector('.settings-range-value');
              if (valueSpan) valueSpan.textContent = value + (valueSpan.textContent.match(/[^\d.]+$/) || [''])[0];
            }
          }
          this._onFieldChanged(key, control);
        }
      }

      this._closeCompareModal();
      this._showToast('✅ 配置已恢复到快照状态', 'success');
    },

    _computeDiff(current, snapshot) {
      let count = 0;
      const allKeys = new Set([...Object.keys(current), ...Object.keys(snapshot)]);
      for (const key of allKeys) {
        if (JSON.stringify(current[key]) !== JSON.stringify(snapshot[key])) {
          count++;
        }
      }
      return count;
    },

    _formatDiffValue(val) {
      if (val === undefined) return '<span class="diff-undefined">未设置</span>';
      if (val === null) return '<span class="diff-null">null</span>';
      if (typeof val === 'boolean') return val ? '✅ true' : '❌ false';
      if (Array.isArray(val)) return val.join(', ') || '<span class="diff-empty">空</span>';
      const str = String(val);
      return str || '<span class="diff-empty">空</span>';
    },

    // ═══════════════════════════════════════
    // 导入导出
    // ═══════════════════════════════════════

    async _exportConfig() {
      try {
        let config;
        if (this._settings) {
          config = await this._settings.exportConfig();
        }

        // 让用户选择导出选项
        const includeSensitive = confirm('是否包含敏感信息（API密钥、密码等）？\n\n选择"确定"包含完整配置\n选择"取消"将自动脱敏敏感字段');
        if (!includeSensitive && config) {
          config = this._sanitizeConfig(config);
        }

        const json = JSON.stringify(config, null, 2);

        // 尝试复制到剪贴板
        try {
          await navigator.clipboard.writeText(json);
          this._showToast('📋 配置已复制到剪贴板', 'success');
        } catch {
          // 回退：创建下载
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `tricore_config_${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          this._showToast('📤 配置已导出下载', 'success');
        }
      } catch (e) {
        this._showToast('导出失败: ' + e.message, 'error');
      }
    },

    _showImportArea() {
      const area = document.getElementById('settings-import-area');
      if (area) {
        area.style.display = 'block';
        area.scrollIntoView({ behavior: 'smooth' });

        document.getElementById('settings-btn-cancel-import').onclick = () => {
          area.style.display = 'none';
          document.getElementById('settings-import-text').value = '';
        };

        document.getElementById('settings-btn-confirm-import').onclick = async () => {
          const text = document.getElementById('settings-import-text').value.trim();
          if (!text) {
            this._showToast('请粘贴配置内容', 'warning');
            return;
          }
          try {
            const config = JSON.parse(text);
            const isMerge = document.getElementById('settings-import-merge')?.checked ?? true;

            if (this._settings) {
              if (isMerge) {
                await this._settings.importConfig(config);
              } else {
                // 全量替换模式：先重置再导入
                await this._settings.resetAll();
                await this._settings.importConfig(config);
              }
            }
            area.style.display = 'none';
            document.getElementById('settings-import-text').value = '';
            this._showToast('📥 配置已导入' + (isMerge ? '（合并模式）' : '（替换模式）'), 'success');

            // 刷新当前分类
            if (this._currentSection) {
              this._switchSection(this._currentSection);
            }
          } catch (e) {
            this._showToast('导入失败: JSON格式错误 - ' + e.message, 'error');
          }
        };
      }
    },

    _sanitizeConfig(config) {
      const sanitized = JSON.parse(JSON.stringify(config));
      const sensitiveKeys = ['apiKey', 'apiToken', 'botToken', 'appSecret', 'password', 'secret', 'token'];
      const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
          if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
            if (typeof obj[key] === 'string' && obj[key]) {
              obj[key] = '***脱敏***';
            }
          } else if (typeof obj[key] === 'object') {
            walk(obj[key]);
          }
        }
      };
      walk(sanitized);
      return sanitized;
    },

    // ═══════════════════════════════════════
    // 快捷键录制
    // ═══════════════════════════════════════

    _startKeybindingRecord(input) {
      input.placeholder = '正在录制...按下组合键...';
      input.classList.add('recording');
      const btn = input.parentElement.querySelector('.settings-keybinding-record');
      if (btn) btn.textContent = '⏹';

      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
        if (e.key && !['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
          parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
        }
        const binding = parts.join('+');
        input.value = binding;
        input.placeholder = '点击后按键录制...';
        input.classList.remove('recording');
        if (btn) btn.textContent = '🎹';
        this._onFieldChanged(input.dataset.key, input);
        document.removeEventListener('keydown', handler);
      };

      document.addEventListener('keydown', handler);

      // 超时取消
      setTimeout(() => {
        if (input.classList.contains('recording')) {
          input.placeholder = '点击后按键录制...';
          input.classList.remove('recording');
          if (btn) btn.textContent = '🎹';
          document.removeEventListener('keydown', handler);
        }
      }, 5000);
    },

    // ═══════════════════════════════════════
    // 搜索与过滤
    // ═══════════════════════════════════════

    _filterNav(query) {
      const items = this._overlay.querySelectorAll('.settings-nav-item');
      const lower = query.toLowerCase();
      let firstMatch = null;
      let matchCount = 0;

      // 也搜索字段
      const schema = this._getSchema();
      const matchingSections = new Set();

      if (lower) {
        for (const section of schema) {
          // 检查分类标题
          if (this._stripIconPrefix(section.title).toLowerCase().includes(lower) ||
              section.description.toLowerCase().includes(lower)) {
            matchingSections.add(section.id);
          }
          // 检查字段
          for (const group of section.groups) {
            for (const field of group.fields) {
              if (field.label.toLowerCase().includes(lower) ||
                  field.key.toLowerCase().includes(lower) ||
                  (field.description && field.description.toLowerCase().includes(lower))) {
                matchingSections.add(section.id);
              }
            }
          }
        }
      }

      items.forEach(item => {
        const sectionId = item.dataset.section;
        const text = item.textContent.toLowerCase();
        const matches = !lower || text.includes(lower) || matchingSections.has(sectionId);

        if (matches) {
          item.style.display = '';
          if (!firstMatch) firstMatch = item;
          matchCount++;
        } else {
          item.style.display = 'none';
        }
      });

      // 显示/隐藏搜索清除按钮
      const clearBtn = document.getElementById('settings-search-clear');
      if (clearBtn) clearBtn.style.display = lower ? '' : 'none';

      if (firstMatch && query) {
        this._switchSection(firstMatch.dataset.section);
      }
    },

    // ═══════════════════════════════════════
    // 工具方法
    // ═══════════════════════════════════════

    _getSchema() {
      if (this._settings && typeof this._settings.getSchema === 'function') {
        return this._settings.getSchema();
      }
      return [];
    },

    _findFieldSchema(key) {
      const schema = this._getSchema();
      for (const section of schema) {
        for (const group of section.groups) {
          const field = group.fields.find(f => f.key === key);
          if (field) return field;
        }
      }
      return null;
    },

    _countFields(section) {
      let count = 0;
      for (const group of section.groups) {
        count += group.fields.length;
      }
      return count;
    },

    _getSectionKeys(section) {
      const keys = [];
      for (const group of section.groups) {
        for (const field of group.fields) {
          keys.push(field.key);
        }
      }
      return keys;
    },

    _computeStats() {
      const schema = this._getSchema();
      let totalFields = 0;
      for (const section of schema) {
        totalFields += this._countFields(section);
      }
      return {
        totalSections: schema.length,
        totalFields,
      };
    },

    _stripIconPrefix(title) {
      return title.replace(/^[^\s]+\s/, '');
    },

    _maskValue(value) {
      if (!value) return '';
      if (value.startsWith('****')) return value;
      if (value.length <= 4) return '****';
      return '****' + value.slice(-4);
    },

    _escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    },

    _escapeAttr(str) {
      if (!str) return '';
      return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    },

    _focusPanel() {
      if (this._dialog) {
        this._dialog.style.animation = 'none';
        this._dialog.offsetHeight; // reflow
        this._dialog.style.animation = '';
      }
    },

    _showToast(message, type = 'info') {
      const container = document.getElementById('settings-toast-container');
      if (!container) return;

      const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
      const toast = document.createElement('div');
      toast.className = `settings-toast ${type}`;
      toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
        <span class="toast-text">${message}</span>
        <button class="toast-close">✕</button>
      `;

      toast.querySelector('.toast-close').addEventListener('click', () => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 200);
      });

      container.appendChild(toast);

      // 自动消失
      const duration = type === 'error' ? 5000 : 3000;
      setTimeout(() => {
        if (toast.parentElement) {
          toast.classList.add('removing');
          setTimeout(() => {
            if (toast.parentElement) toast.remove();
          }, 200);
        }
      }, duration);
    },
  };

  console.log('[蜜糖 TriCore SettingsPanel v6.0] UI 控制器已初始化');
})();
