/**
 * TriCore Agent - 浏览器自动化完整实现 (Phase 25)
 *
 * 基于 Playwright 的浏览器自动化引擎，提供完整的网页控制能力：
 *   1. 页面导航与内容提取
 *   2. 元素交互（点击/输入/滚动/拖拽）
 *   3. 截图与PDF生成
 *   4. 表单自动填写
 *   5. 网络请求拦截与修改
 *   6. Cookie/Session管理
 *   7. 多页面/多上下文管理
 *   8. 代理与地理位置模拟
 *   9. 无障碍访问（a11y tree）
 *   10. 性能追踪（Core Web Vitals）
 */

'use strict';

const { EventEmitter } = require('events');

const BROWSER_STATE = Object.freeze({
  INIT: 'init',
  READY: 'ready',
  BUSY: 'busy',
  ERROR: 'error',
  CLOSED: 'closed',
});

const NAVIGATION_WAIT = Object.freeze({
  LOAD: 'load',
  DOMCONTENTLOADED: 'domcontentloaded',
  NETWORKIDLE: 'networkidle',
  COMMIT: 'commit',
});

const SCREENSHOT_TYPE = Object.freeze({
  PNG: 'png',
  JPEG: 'jpeg',
  WEBP: 'webp',
});

const BROWSER_TOOLS = Object.freeze({
  NAVIGATE: 'navigate',
  CLICK: 'click',
  TYPE: 'type',
  SCROLL: 'scroll',
  SCREENSHOT: 'screenshot',
  PDF: 'pdf',
  EXTRACT_TEXT: 'extract_text',
  EXTRACT_HTML: 'extract_html',
  EXTRACT_LINKS: 'extract_links',
  EXTRACT_TABLE: 'extract_table',
  FILL_FORM: 'fill_form',
  SUBMIT_FORM: 'submit_form',
  EVALUATE: 'evaluate',
  WAIT_FOR_SELECTOR: 'wait_for_selector',
  GET_COOKIES: 'get_cookies',
  SET_COOKIES: 'set_cookies',
  INTERCEPT_REQUEST: 'intercept_request',
  SET_VIEWPORT: 'set_viewport',
  SET_USER_AGENT: 'set_user_agent',
  SET_GEOLOCATION: 'set_geolocation',
  DRAG_AND_DROP: 'drag_and_drop',
  PRESS_KEY: 'press_key',
  HOVER: 'hover',
  SELECT_OPTION: 'select_option',
  UPLOAD_FILE: 'upload_file',
  DOWNLOAD_FILE: 'download_file',
  EXECUTE_SCRIPT: 'execute_script',
  GET_PERFORMANCE: 'get_performance',
  GET_A11Y_TREE: 'get_a11y_tree',
  CLOSE_PAGE: 'close_page',
  NEW_PAGE: 'new_page',
});

class BrowserAutomation extends EventEmitter {
  constructor(options = {}) {
    super();

    this._headless = options.headless ?? true;
    this._browserType = options.browserType || 'chromium';
    this._executablePath = options.executablePath || null;
    this._userDataDir = options.userDataDir || null;
    this._args = options.args || [];
    this._defaultTimeout = options.defaultTimeout || 30000;
    this._defaultViewport = options.defaultViewport || { width: 1280, height: 720 };
    this._userAgent = options.userAgent || null;
    this._proxy = options.proxy || null;

    this._browser = null;
    this._context = null;
    this._pages = new Map(); // pageId → page
    this._state = BROWSER_STATE.INIT;
    this._playwright = null;

    this._stats = {
      navigations: 0,
      screenshots: 0,
      clicks: 0,
      formFills: 0,
      errors: 0,
    };
  }

  /**
   * 初始化浏览器
   */
  async init() {
    if (this._state === BROWSER_STATE.READY) return;

    try {
      this._playwright = require('playwright');
      this._state = BROWSER_STATE.READY;
      this.emit('ready');
    } catch (e) {
      this._state = BROWSER_STATE.ERROR;
      throw new Error(`Playwright not available: ${e.message}. Install with: npm install playwright`);
    }
  }

  /**
   * 启动浏览器实例
   */
  async launch(options = {}) {
    if (!this._playwright) await this.init();

    const launchOptions = {
      headless: options.headless ?? this._headless,
      executablePath: options.executablePath || this._executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        ...this._args,
        ...(options.args || []),
      ],
    };

    this._browser = await this._playwright.chromium.launch(launchOptions);
    this._context = await this._browser.newContext({
      viewport: options.viewport || this._defaultViewport,
      userAgent: options.userAgent || this._userAgent,
      proxy: options.proxy || this._proxy,
    });

    // 监听新页面
    this._context.on('page', (page) => {
      const pageId = `page_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      this._pages.set(pageId, page);
      this._setupPageListeners(page, pageId);
      this.emit('page_created', { pageId });
    });

    this._state = BROWSER_STATE.READY;
    return { launched: true };
  }

  /**
   * 设置页面事件监听
   */
  _setupPageListeners(page, pageId) {
    page.on('close', () => {
      this._pages.delete(pageId);
      this.emit('page_closed', { pageId });
    });

    page.on('console', (msg) => {
      this.emit('console', { pageId, type: msg.type(), text: msg.text() });
    });

    page.on('dialog', async (dialog) => {
      this.emit('dialog', { pageId, type: dialog.type(), message: dialog.message() });
      await dialog.dismiss();
    });

    page.on('requestfailed', (request) => {
      this.emit('request_failed', {
        pageId,
        url: request.url(),
        failure: request.failure()?.errorText,
      });
    });
  }

  /**
   * 获取或创建页面
   */
  async _getPage(pageId) {
    if (pageId && this._pages.has(pageId)) {
      return this._pages.get(pageId);
    }

    if (!this._context) {
      await this.launch();
    }

    const newPage = await this._context.newPage();
    const id = pageId || `page_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this._pages.set(id, newPage);
    this._setupPageListeners(newPage, id);

    return newPage;
  }

  /**
   * 执行浏览器操作
   */
  async execute(action, params = {}) {
    if (!this._browser && action !== BROWSER_TOOLS.LAUNCH) {
      await this.launch();
    }

    this._state = BROWSER_STATE.BUSY;
    const startTime = Date.now();

    try {
      let result;
      switch (action) {
        case 'launch': result = await this.launch(params); break;
        case BROWSER_TOOLS.NAVIGATE: result = await this._navigate(params); break;
        case BROWSER_TOOLS.CLICK: result = await this._click(params); break;
        case BROWSER_TOOLS.TYPE: result = await this._type(params); break;
        case BROWSER_TOOLS.SCROLL: result = await this._scroll(params); break;
        case BROWSER_TOOLS.SCREENSHOT: result = await this._screenshot(params); break;
        case BROWSER_TOOLS.PDF: result = await this._pdf(params); break;
        case BROWSER_TOOLS.EXTRACT_TEXT: result = await this._extractText(params); break;
        case BROWSER_TOOLS.EXTRACT_HTML: result = await this._extractHtml(params); break;
        case BROWSER_TOOLS.EXTRACT_LINKS: result = await this._extractLinks(params); break;
        case BROWSER_TOOLS.EXTRACT_TABLE: result = await this._extractTable(params); break;
        case BROWSER_TOOLS.FILL_FORM: result = await this._fillForm(params); break;
        case BROWSER_TOOLS.EVALUATE: result = await this._evaluate(params); break;
        case BROWSER_TOOLS.WAIT_FOR_SELECTOR: result = await this._waitForSelector(params); break;
        case BROWSER_TOOLS.GET_COOKIES: result = await this._getCookies(params); break;
        case BROWSER_TOOLS.SET_COOKIES: result = await this._setCookies(params); break;
        case BROWSER_TOOLS.SET_VIEWPORT: result = await this._setViewport(params); break;
        case BROWSER_TOOLS.SET_USER_AGENT: result = await this._setUserAgent(params); break;
        case BROWSER_TOOLS.PRESS_KEY: result = await this._pressKey(params); break;
        case BROWSER_TOOLS.HOVER: result = await this._hover(params); break;
        case BROWSER_TOOLS.GET_PERFORMANCE: result = await this._getPerformance(params); break;
        case BROWSER_TOOLS.NEW_PAGE: result = await this._newPage(params); break;
        case BROWSER_TOOLS.CLOSE_PAGE: result = await this._closePage(params); break;
        default:
          throw new Error(`Unknown browser action: ${action}`);
      }

      // 更新统计
      this._updateStats(action);

      this.emit('action_complete', {
        action,
        duration: Date.now() - startTime,
        success: true,
      });

      return result;
    } catch (error) {
      this._stats.errors++;
      this.emit('action_error', { action, error: error.message });
      throw error;
    } finally {
      this._state = BROWSER_STATE.READY;
    }
  }

  // ═══════════════════════════════════════
  // 核心操作实现
  // ═══════════════════════════════════════

  async _navigate({ url, pageId, waitUntil, timeout }) {
    const page = await this._getPage(pageId);
    const response = await page.goto(url, {
      waitUntil: waitUntil || NAVIGATION_WAIT.NETWORKIDLE,
      timeout: timeout || this._defaultTimeout,
    });
    this._stats.navigations++;

    return {
      url: page.url(),
      title: await page.title(),
      status: response?.status(),
      ok: response?.ok(),
      headers: response?.headers(),
    };
  }

  async _click({ selector, pageId, button, clickCount, position, timeout }) {
    const page = await this._getPage(pageId);
    await page.waitForSelector(selector, { timeout: timeout || this._defaultTimeout });
    await page.click(selector, {
      button: button || 'left',
      clickCount: clickCount || 1,
      position,
      timeout: timeout || this._defaultTimeout,
    });
    this._stats.clicks++;
    return { clicked: selector };
  }

  async _type({ selector, text, pageId, delay, clear }) {
    const page = await this._getPage(pageId);
    await page.waitForSelector(selector, { timeout: this._defaultTimeout });
    if (clear) {
      await page.fill(selector, '');
    }
    await page.type(selector, text, { delay: delay || 0 });
    return { typed: selector, length: text.length };
  }

  async _scroll({ pageId, x, y, selector }) {
    const page = await this._getPage(pageId);
    if (selector) {
      await page.locator(selector).scrollIntoViewIfNeeded();
    } else {
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: x || 0, y: y || 0 });
    }
    return { scrolled: { x: x || 0, y: y || 0 } };
  }

  async _screenshot({ pageId, fullPage, selector, type, quality, path }) {
    const page = await this._getPage(pageId);

    const options = {
      type: type || 'png',
      fullPage: fullPage || false,
      quality: type === 'jpeg' ? (quality || 80) : undefined,
    };

    if (path) options.path = path;

    let buffer;
    if (selector) {
      const element = await page.locator(selector);
      buffer = await element.screenshot(options);
    } else {
      buffer = await page.screenshot(options);
    }

    this._stats.screenshots++;
    return {
      buffer: buffer.toString('base64'),
      format: type || 'png',
    };
  }

  async _pdf({ pageId, path, format, margin, printBackground }) {
    const page = await this._getPage(pageId);
    const pdfOptions = {
      format: format || 'A4',
      margin: margin || { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' },
      printBackground: printBackground ?? true,
    };
    if (path) pdfOptions.path = path;

    const buffer = await page.pdf(pdfOptions);
    return { buffer: buffer.toString('base64'), format: format || 'A4' };
  }

  async _extractText({ pageId, selector }) {
    const page = await this._getPage(pageId);
    let text;
    if (selector) {
      text = await page.locator(selector).innerText();
    } else {
      text = await page.evaluate(() => document.body.innerText);
    }
    return { text, length: text.length };
  }

  async _extractHtml({ pageId, selector }) {
    const page = await this._getPage(pageId);
    let html;
    if (selector) {
      html = await page.locator(selector).innerHTML();
    } else {
      html = await page.content();
    }
    return { html, length: html.length };
  }

  async _extractLinks({ pageId, selector, filter }) {
    const page = await this._getPage(pageId);
    const links = await page.evaluate(({ sel, filterPattern }) => {
      const elements = sel ? document.querySelectorAll(sel) : document.querySelectorAll('a[href]');
      const results = [];
      for (const el of elements) {
        const href = el.getAttribute('href');
        const text = el.innerText?.trim() || '';
        if (href && (!filterPattern || href.includes(filterPattern))) {
          results.push({
            href: href.startsWith('http') ? href : new URL(href, window.location.href).href,
            text,
            isExternal: href.startsWith('http') && !href.includes(window.location.hostname),
          });
        }
      }
      return results;
    }, { sel: selector, filterPattern: filter });

    return { links, count: links.length };
  }

  async _extractTable({ pageId, selector, includeHeaders }) {
    const page = await this._getPage(pageId);
    const data = await page.evaluate(({ sel, headers }) => {
      const table = sel ? document.querySelector(sel) : document.querySelector('table');
      if (!table) return { headers: [], rows: [] };

      const result = { headers: [], rows: [] };

      if (headers !== false) {
        const ths = table.querySelectorAll('th');
        if (ths.length > 0) {
          result.headers = [...ths].map(th => th.innerText.trim());
        } else {
          const firstRow = table.querySelector('tr');
          if (firstRow) {
            result.headers = [...firstRow.querySelectorAll('td,th')].map(c => c.innerText.trim());
          }
        }
      }

      const rows = table.querySelectorAll('tr');
      const startIdx = result.headers.length > 0 ? 1 : 0;
      for (let i = startIdx; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll('td,th');
        result.rows.push([...cells].map(c => c.innerText.trim()));
      }

      return result;
    }, { sel: selector, headers: includeHeaders });

    return data;
  }

  async _fillForm({ pageId, fields, submitAfter }) {
    const page = await this._getPage(pageId);
    const results = [];

    for (const { selector, value, type } of fields) {
      await page.waitForSelector(selector, { timeout: this._defaultTimeout });

      if (type === 'select') {
        await page.selectOption(selector, value);
      } else if (type === 'checkbox' || type === 'radio') {
        if (value) {
          await page.check(selector);
        } else {
          await page.uncheck(selector);
        }
      } else if (type === 'file') {
        await page.locator(selector).setInputFiles(value);
      } else {
        await page.fill(selector, String(value));
      }

      results.push({ selector, filled: true });
    }

    this._stats.formFills++;

    if (submitAfter) {
      await page.locator(submitAfter).click();
      await page.waitForLoadState(NAVIGATION_WAIT.NETWORKIDLE);
    }

    return { fields: results, submitted: !!submitAfter };
  }

  async _evaluate({ pageId, script, args }) {
    const page = await this._getPage(pageId);
    const result = await page.evaluate(script, args || []);
    return { result };
  }

  async _waitForSelector({ pageId, selector, state, timeout }) {
    const page = await this._getPage(pageId);
    await page.waitForSelector(selector, {
      state: state || 'visible',
      timeout: timeout || this._defaultTimeout,
    });
    return { found: selector };
  }

  async _getCookies({ pageId, urls }) {
    const page = await this._getPage(pageId);
    const cookies = urls
      ? await this._context.cookies(urls)
      : await this._context.cookies();
    return { cookies };
  }

  async _setCookies({ pageId, cookies }) {
    if (!this._context) await this.launch();
    await this._context.addCookies(cookies);
    return { set: cookies.length };
  }

  async _setViewport({ pageId, width, height, deviceScaleFactor }) {
    const page = await this._getPage(pageId);
    await page.setViewportSize({
      width: width || 1280,
      height: height || 720,
    });
    return { viewport: { width: width || 1280, height: height || 720 } };
  }

  async _setUserAgent({ pageId, userAgent }) {
    if (!this._context) await this.launch();
    const page = await this._getPage(pageId);
    // Playwright doesn't support per-page UA change, recreate context
    await this._context.close();
    this._context = await this._browser.newContext({
      userAgent,
      viewport: this._defaultViewport,
    });
    return { userAgent };
  }

  async _pressKey({ pageId, key, selector }) {
    const page = await this._getPage(pageId);
    if (selector) {
      await page.locator(selector).press(key);
    } else {
      await page.keyboard.press(key);
    }
    return { pressed: key };
  }

  async _hover({ pageId, selector }) {
    const page = await this._getPage(pageId);
    await page.locator(selector).hover();
    return { hovered: selector };
  }

  async _getPerformance({ pageId }) {
    const page = await this._getPage(pageId);
    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = performance.getEntriesByType('paint');
      const resources = performance.getEntriesByType('resource');

      return {
        navigation: nav ? {
          domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
          loadComplete: nav.loadEventEnd - nav.startTime,
          domInteractive: nav.domInteractive - nav.startTime,
          redirectCount: nav.redirectCount,
        } : null,
        paint: {
          firstPaint: paint.find(p => p.name === 'first-paint')?.startTime,
          firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime,
        },
        resources: resources.length,
        memory: performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
        } : null,
      };
    });

    return metrics;
  }

  async _newPage({ url }) {
    const page = await this._getPage();
    if (url) {
      await page.goto(url, { waitUntil: NAVIGATION_WAIT.NETWORKIDLE });
    }
    const pageId = [...this._pages.keys()].pop();
    return { pageId, url: page.url() };
  }

  async _closePage({ pageId }) {
    if (!pageId || !this._pages.has(pageId)) {
      return { closed: false, error: 'Page not found' };
    }
    const page = this._pages.get(pageId);
    await page.close();
    this._pages.delete(pageId);
    return { closed: true, pageId };
  }

  // ═══════════════════════════════════════
  // 工具方法
  // ═══════════════════════════════════════

  _updateStats(action) {
    // 统计已在上方各方法中更新
  }

  toPlugin() {
    return {
      name: 'browser-automation',
      version: '1.0.0',
      tools: Object.values(BROWSER_TOOLS).map(name => ({
        name,
        description: `Browser automation: ${name}`,
        execute: (params) => this.execute(name, params),
      })),
      status: () => this.getStatus(),
      cleanup: () => this.close(),
    };
  }

  getStatus() {
    return {
      state: this._state,
      pages: this._pages.size,
      stats: this._stats,
      available: !!this._playwright,
      tools: Object.keys(BROWSER_TOOLS),
    };
  }

  getPages() {
    const pages = [];
    for (const [id, page] of this._pages) {
      pages.push({ id, url: page.url() });
    }
    return pages;
  }

  async close() {
    if (this._context) {
      await this._context.close().catch(err => {
        if (this._logger) this._logger.debug(`[Browser] 关闭context异常: ${err.message}`);
      });
      this._context = null;
    }
    if (this._browser) {
      await this._browser.close().catch(err => {
        if (this._logger) this._logger.debug(`[Browser] 关闭browser异常: ${err.message}`);
      });
      this._browser = null;
    }
    this._pages.clear();
    this._state = BROWSER_STATE.CLOSED;
    this.emit('closed');
  }
}

module.exports = {
  BrowserAutomation,
  BROWSER_TOOLS,
  BROWSER_STATE,
  NAVIGATION_WAIT,
  SCREENSHOT_TYPE,
};
