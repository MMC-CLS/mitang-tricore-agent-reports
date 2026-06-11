/**
 * TriCore Agent - 多模态感知引擎 (Multi-Modal Perception Engine)
 *
 * Phase 13: 多模态感知 - 图像/截图/文档理解
 *
 * 核心能力:
 *   1. 图像理解 - 支持视觉LLM (GPT-4V/Claude Vision/Qwen-VL等)
 *   2. 截图分析 - 屏幕截图自动理解+OCR
 *   3. 文档解析 - PDF/Word/Excel内容提取
 *   4. 多图对比 - 多张图片并列分析
 *   5. 图像描述 - 自动生成图片alt文本
 *   6. OCR文字识别 - 图片中文字提取
 *   7. 图表理解 - 图表/表格数据提取
 *   8. 视觉问答 - 基于图片的问答
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// ── 模态类型 ──
const MODALITY_TYPE = Object.freeze({
  IMAGE: 'image',
  SCREENSHOT: 'screenshot',
  DOCUMENT: 'document',
  PDF: 'pdf',
  SPREADSHEET: 'spreadsheet',
  AUDIO: 'audio',
  VIDEO_FRAME: 'video_frame',
});

// ── 图片格式支持 ──
const SUPPORTED_IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

// ── 文档格式支持 ──
const SUPPORTED_DOC_FORMATS = ['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md'];

class MultiModalEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this._router = options.router || null;
    this._browser = options.browser || null;
    this._memory = options.memory || null;
    this._security = options.security || null;

    // 视觉模型配置
    this._visionProvider = options.visionProvider || null;
    this._visionModel = options.visionModel || null;
    this._visionEnabled = options.visionEnabled ?? true;

    // OCR配置
    this._ocrProvider = options.ocrProvider || 'builtin';
    this._ocrLanguage = options.ocrLanguage || 'chi_sim+eng';

    // 缓存
    this._imageCache = new Map();
    this._maxCacheSize = options.maxCacheSize ?? 200;

    // 统计
    this._stats = {
      imagesProcessed: 0,
      documentsParsed: 0,
      screenshotsTaken: 0,
      ocrCalls: 0,
    };
  }

  // ═══════════════════════════════════════
  // 图像处理
  // ═══════════════════════════════════════

  /**
   * 分析图片（视觉理解）
   * @param {string} imagePath - 图片路径或base64数据
   * @param {string} prompt - 分析提示词
   * @param {Object} options - { detail?, maxTokens? }
   * @returns {Object} { description, objects, text, confidence }
   */
  async analyzeImage(imagePath, prompt = '请详细描述这张图片的内容。', options = {}) {
    this._stats.imagesProcessed++;

    // 读取并编码图片
    const imageData = await this._loadImage(imagePath);
    if (!imageData) {
      return { error: 'Failed to load image', description: '', objects: [], text: '' };
    }

    // 缓存检查
    const cacheKey = this._hashImage(imageData);
    if (this._imageCache.has(cacheKey + prompt.substring(0, 50))) {
      return this._imageCache.get(cacheKey + prompt.substring(0, 50));
    }

    if (!this._router || !this._visionEnabled) {
      return {
        description: `[图片分析需要视觉LLM支持] 图片大小: ${(imageData.length / 1024).toFixed(1)}KB`,
        objects: [],
        text: '',
        confidence: 0,
      };
    }

    try {
      const { MODEL_PURPOSE } = require('../providers/model-router');
      const result = await this._router.call({
        purpose: MODEL_PURPOSE.CONSCIOUSNESS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/${this._getImageType(imagePath)};base64,${imageData}`,
                  detail: options.detail || 'auto',
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: options.maxTokens || 2048,
      });

      const analysis = this._parseImageAnalysis(result.content || '', prompt);

      // 缓存
      if (this._imageCache.size >= this._maxCacheSize) {
        const firstKey = this._imageCache.keys().next().value;
        this._imageCache.delete(firstKey);
      }
      this._imageCache.set(cacheKey + prompt.substring(0, 50), analysis);

      this.emit('image_analyzed', { imagePath, prompt: prompt.substring(0, 50) });
      return analysis;
    } catch (e) {
      return { error: e.message, description: '', objects: [], text: '' };
    }
  }

  /**
   * 分析多张图片（并列对比）
   */
  async compareImages(imagePaths, prompt = '请对比分析这些图片。') {
    if (!this._router || !this._visionEnabled) {
      return { comparison: '[多图对比需要视觉LLM支持]' };
    }

    const content = [];

    for (const imagePath of imagePaths) {
      const imageData = await this._loadImage(imagePath);
      if (imageData) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:image/${this._getImageType(imagePath)};base64,${imageData}`,
            detail: 'auto',
          },
        });
      }
    }

    content.push({ type: 'text', text: prompt });

    try {
      const { MODEL_PURPOSE } = require('../providers/model-router');
      const result = await this._router.call({
        purpose: MODEL_PURPOSE.CONSCIOUSNESS,
        messages: [{ role: 'user', content }],
        temperature: 0.3,
        max_tokens: 4096,
      });

      return {
        comparison: result.content || '',
        imageCount: imagePaths.length,
      };
    } catch (e) {
      return { error: e.message, comparison: '' };
    }
  }

  // ═══════════════════════════════════════
  // 截图处理
  // ═══════════════════════════════════════

  /**
   * 截取屏幕并分析
   */
  async captureScreen(prompt = '请描述当前屏幕显示的内容。') {
    this._stats.screenshotsTaken++;

    if (this._browser) {
      try {
        const screenshot = await this._browser.execute('screenshot', { fullPage: false });
        if (screenshot?.data) {
          return this.analyzeImage(`data:image/png;base64,${screenshot.data}`, prompt);
        }
      } catch (e) {
        // 截图失败
      }
    }

    return {
      description: '[截图功能需要浏览器自动化支持]',
      objects: [],
      text: '',
      confidence: 0,
    };
  }

  /**
   * 批量截图（网页巡检）
   */
  async captureScreenshots(urls, options = {}) {
    const results = [];
    for (const url of urls) {
      if (this._browser) {
        try {
          await this._browser.execute('navigate', { url });
          await this._sleep(2000);
          const screenshot = await this._browser.execute('screenshot', {});
          if (screenshot?.data) {
            const analysis = await this.analyzeImage(
              `data:image/png;base64,${screenshot.data}`,
              `分析网页 ${url} 的截图内容。`
            );
            results.push({ url, ...analysis });
          }
        } catch (e) {
          results.push({ url, error: e.message });
        }
      }
    }
    return results;
  }

  // ═══════════════════════════════════════
  // OCR文字识别
  // ═══════════════════════════════════════

  /**
   * OCR识别图片中的文字
   * @param {string} imagePath - 图片路径
   * @param {Object} options - { language?, enhance? }
   */
  async ocr(imagePath, options = {}) {
    this._stats.ocrCalls++;

    const imageData = await this._loadImage(imagePath);
    if (!imageData) return { text: '', confidence: 0, error: 'Failed to load image' };

    // 使用视觉LLM做OCR（更好的效果）
    if (this._router && this._visionEnabled) {
      try {
        const { MODEL_PURPOSE } = require('../providers/model-router');
        const result = await this._router.call({
          purpose: MODEL_PURPOSE.EXECUTION,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/${this._getImageType(imagePath)};base64,${imageData}`,
                    detail: 'high',
                  },
                },
                {
                  type: 'text',
                  text: `请识别并提取这张图片中的所有文字内容。${
                    options.language ? `语言: ${options.language}` : ''
                  }\n请只输出识别到的文字，不要添加任何解释。如果图片中没有文字，请回复"无文字内容"。`,
                },
              ],
            },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        });

        const text = result.content || '';
        return {
          text,
          confidence: text.length > 0 ? 0.9 : 0,
          method: 'vision_llm',
        };
      } catch (e) {
        return { text: '', confidence: 0, error: e.message, method: 'vision_llm_failed' };
      }
    }

    return { text: '[OCR需要视觉LLM支持]', confidence: 0, method: 'unavailable' };
  }

  // ═══════════════════════════════════════
  // 文档解析
  // ═══════════════════════════════════════

  /**
   * 解析文档内容
   */
  async parseDocument(filePath, options = {}) {
    this._stats.documentsParsed++;

    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}`, content: '' };
    }

    const ext = path.extname(filePath).toLowerCase();

    try {
      switch (ext) {
        case '.txt':
        case '.md':
        case '.json':
        case '.xml':
        case '.yaml':
        case '.yml':
        case '.csv':
        case '.js':
        case '.ts':
        case '.py':
        case '.html':
        case '.css':
          return {
            content: fs.readFileSync(filePath, 'utf-8'),
            type: ext.slice(1),
            size: fs.statSync(filePath).size,
          };

        case '.pdf':
          return this._parsePDF(filePath, options);

        case '.docx':
          return this._parseDOCX(filePath, options);

        case '.xlsx':
          return this._parseXLSX(filePath, options);

        default:
          return {
            content: `[不支持的文件格式: ${ext}]`,
            type: 'unknown',
            size: 0,
          };
      }
    } catch (e) {
      return { error: e.message, content: '', type: ext.slice(1) };
    }
  }

  _parsePDF(filePath, options = {}) {
    // PDF解析 - 尝试使用pdf-parse或返回需要安装的提示
    try {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      return pdfParse(dataBuffer).then(data => ({
        content: data.text,
        type: 'pdf',
        pages: data.numpages,
        info: data.info,
      })).catch(() => ({
        content: `[PDF文件: ${path.basename(filePath)}] - 解析需要pdf-parse库`,
        type: 'pdf',
        needsDependency: 'pdf-parse',
      }));
    } catch {
      return {
        content: `[PDF文件: ${path.basename(filePath)}]\n安装pdf-parse以启用PDF解析: npm install pdf-parse`,
        type: 'pdf',
        needsDependency: 'pdf-parse',
      };
    }
  }

  _parseDOCX(filePath, options = {}) {
    try {
      const mammoth = require('mammoth');
      return mammoth.extractRawText({ path: filePath }).then(result => ({
        content: result.value,
        type: 'docx',
        warnings: result.messages,
      })).catch(() => ({
        content: `[Word文件: ${path.basename(filePath)}] - 解析需要mammoth库`,
        type: 'docx',
        needsDependency: 'mammoth',
      }));
    } catch {
      return {
        content: `[Word文件: ${path.basename(filePath)}]\n安装mammoth以启用DOCX解析: npm install mammoth`,
        type: 'docx',
        needsDependency: 'mammoth',
      };
    }
  }

  _parseXLSX(filePath, options = {}) {
    try {
      const XLSX = require('xlsx');
      const workbook = XLSX.readFile(filePath);
      const sheets = {};
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        sheets[sheetName] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      }
      return {
        content: JSON.stringify(sheets, null, 2),
        type: 'xlsx',
        sheets: workbook.SheetNames,
        rawData: sheets,
      };
    } catch {
      return {
        content: `[Excel文件: ${path.basename(filePath)}]\n安装xlsx以启用XLSX解析: npm install xlsx`,
        type: 'xlsx',
        needsDependency: 'xlsx',
      };
    }
  }

  // ═══════════════════════════════════════
  // 视觉问答
  // ═══════════════════════════════════════

  /**
   * 基于图片的问答
   */
  async visualQA(imagePath, question) {
    if (!this._router || !this._visionEnabled) {
      return { answer: '[视觉问答需要视觉LLM支持]' };
    }

    const imageData = await this._loadImage(imagePath);
    if (!imageData) return { answer: '', error: 'Failed to load image' };

    try {
      const { MODEL_PURPOSE } = require('../providers/model-router');
      const result = await this._router.call({
        purpose: MODEL_PURPOSE.CONSCIOUSNESS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/${this._getImageType(imagePath)};base64,${imageData}`,
                  detail: 'high',
                },
              },
              { type: 'text', text: question },
            ],
          },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      });

      return { answer: result.content || '', question };
    } catch (e) {
      return { answer: '', error: e.message };
    }
  }

  // ═══════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════

  async _loadImage(imagePath) {
    // 支持文件路径和base64 data URL
    if (imagePath.startsWith('data:image/')) {
      const base64 = imagePath.split(',')[1];
      return base64;
    }

    if (!fs.existsSync(imagePath)) return null;

    const ext = path.extname(imagePath).toLowerCase().slice(1);
    if (!SUPPORTED_IMAGE_FORMATS.includes(ext)) return null;

    return fs.readFileSync(imagePath).toString('base64');
  }

  _getImageType(imagePath) {
    if (imagePath.startsWith('data:image/')) {
      return imagePath.split(';')[0].split('/')[1] || 'png';
    }
    const ext = path.extname(imagePath).toLowerCase().slice(1);
    return ext === 'jpg' ? 'jpeg' : ext;
  }

  _hashImage(base64Data) {
    let hash = 0;
    const sample = base64Data.substring(0, 200);
    for (let i = 0; i < sample.length; i++) {
      hash = ((hash << 5) - hash) + sample.charCodeAt(i);
      hash |= 0;
    }
    return `img_${Math.abs(hash).toString(36)}`;
  }

  _parseImageAnalysis(content, prompt) {
    return {
      description: content || '',
      objects: this._extractObjects(content),
      text: this._extractTextFromAnalysis(content),
      confidence: content.length > 0 ? 0.85 : 0,
      prompt: prompt.substring(0, 100),
    };
  }

  _extractObjects(analysis) {
    // 简单提取分析中的对象描述
    const objects = [];
    const lines = analysis.split('\n');
    for (const line of lines) {
      const match = line.match(/[•\-\*]\s*(.+)/);
      if (match) objects.push(match[1].trim());
    }
    return objects.slice(0, 20);
  }

  _extractTextFromAnalysis(analysis) {
    // 尝试从分析中提取文字内容
    const textMatch = analysis.match(/(?:文字|文本|内容)[：:]\s*(.+)/);
    return textMatch ? textMatch[1].trim() : '';
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════
  // 本地图片处理降级（Phase 21 - 无LLM时的基础图片分析）
  // ═══════════════════════════════════════

  /**
   * 获取图片基本信息（无需LLM）
   */
  async getImageInfo(imagePath) {
    const imageData = await this._loadImage(imagePath);
    if (!imageData) {
      return { error: 'Failed to load image', width: 0, height: 0, size: 0 };
    }

    try {
      // 尝试使用 image-size 库获取尺寸
      const sizeOf = require('image-size');
      const dimensions = sizeOf(Buffer.from(imageData, 'base64'));
      const fileSize = imageData.length * 0.75; // base64 → 原始字节估算
      return {
        width: dimensions.width || 0,
        height: dimensions.height || 0,
        type: dimensions.type || 'unknown',
        sizeBytes: Math.round(fileSize),
        sizeKB: (fileSize / 1024).toFixed(1),
      };
    } catch {
      // image-size 不可用时返回基本估算
      const fileSize = imageData.length * 0.75;
      return {
        width: 0,
        height: 0,
        type: this._getImageType(imagePath),
        sizeBytes: Math.round(fileSize),
        sizeKB: (fileSize / 1024).toFixed(1),
      };
    }
  }

  /**
   * 图片格式转换（base64 → 不同格式）
   */
  async convertImage(imagePath, targetFormat = 'png') {
    const imageData = await this._loadImage(imagePath);
    if (!imageData) return null;

    // 基础格式转换（通过 data URL 前缀）
    return `data:image/${targetFormat};base64,${imageData}`;
  }

  /**
   * 验证图片格式
   */
  validateImageFormat(filePath) {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    return SUPPORTED_IMAGE_FORMATS.includes(ext);
  }

  /**
   * 批量图片信息
   */
  async batchImageInfo(imagePaths) {
    const results = [];
    for (const imagePath of imagePaths) {
      results.push(await this.getImageInfo(imagePath));
    }
    return results;
  }

  // ═══════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════

  getStats() {
    return {
      ...this._stats,
      visionEnabled: this._visionEnabled,
      cacheSize: this._imageCache.size,
      supportedFormats: {
        images: SUPPORTED_IMAGE_FORMATS,
        documents: SUPPORTED_DOC_FORMATS,
      },
    };
  }
}

module.exports = {
  MultiModalEngine,
  MODALITY_TYPE,
  SUPPORTED_IMAGE_FORMATS,
  SUPPORTED_DOC_FORMATS,
};
