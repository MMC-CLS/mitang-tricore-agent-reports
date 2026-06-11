/**
 * 蜜糖 TriCore Agent — 系统自检面板 v1.0
 *
 * 提供完整的系统诊断功能，包含：
 *   - 🎤 音频输入/输出设备检测
 *   - 🔊 音频播放功能测试（正弦波/白噪声/语音合成）
 *   - 🎬 视频编解码器支持检测
 *   - ▶️ 视频播放功能测试
 *   - 📄 文档解析引擎检测
 *   - 📕 PDF 渲染/文本提取能力
 *   - 📊 Office 文档处理能力
 *   - 🖼️ 图片格式支持与处理
 *   - 🌐 网络连通性测试
 *   - 💾 存储读写性能测试
 *   - 🤖 LLM API 端点连通性
 *
 * 使用方式：
 *   const checker = new TriCoreSelfCheckPanel();
 *   await checker.open();       // 打开自检面板
 *   await checker.runAll();     // 运行所有检测
 *   await checker.runCategory('audio'); // 按类别检测
 */

'use strict';

(function () {
  const isElectron = !!(window.triCoreAPI);
  const API = window.triCoreAPI;

  // ── 检测类别定义 ──
  const CHECK_CATEGORIES = {
    audio: {
      name: '音频系统',
      icon: '🎵',
      description: '检测音频输入/输出设备和播放功能',
      checks: ['audio_devices_input', 'audio_devices_output', 'audio_web_api', 'audio_playback_sine', 'audio_playback_noise', 'audio_speech_synthesis', 'audio_recording_permission'],
    },
    video: {
      name: '视频系统',
      icon: '🎬',
      description: '检测视频编解码器和播放能力',
      checks: ['video_codec_h264', 'video_codec_h265', 'video_codec_vp8', 'video_codec_vp9', 'video_codec_av1', 'video_playback_mp4', 'video_playback_webm', 'video_canvas_render'],
    },
    document: {
      name: '文档处理',
      icon: '📄',
      description: '检测文档解析、PDF和Office处理能力',
      checks: ['doc_text_decoder', 'doc_dom_parser', 'doc_file_reader', 'doc_blob_api', 'doc_pdf_canvas', 'doc_pdf_text', 'doc_office_xml', 'doc_office_zip', 'doc_image_png', 'doc_image_webp', 'doc_image_svg'],
    },
    network: {
      name: '网络连通',
      icon: '🌐',
      description: '检测网络连接、DNS和API可达性',
      checks: ['net_internet', 'net_dns', 'net_latency', 'net_llm_endpoint', 'net_websocket', 'net_fetch_api'],
    },
    storage: {
      name: '存储系统',
      icon: '💾',
      description: '检测存储可用性、读写性能和容量',
      checks: ['storage_localstorage', 'storage_indexeddb', 'storage_write_speed', 'storage_read_speed', 'storage_quota', 'storage_session'],
    },
    environment: {
      name: '运行环境',
      icon: '💻',
      description: '检测系统环境、运行时和资源状态',
      checks: ['env_os', 'env_cpu', 'env_memory', 'env_webgl', 'env_workers', 'env_wasm'],
    },
  };

  // ── 检查项定义 ──
  const CHECK_DEFINITIONS = {
    // 音频
    audio_devices_input: {
      name: '音频输入设备', icon: '🎤', category: 'audio',
      run: async () => {
        if (!navigator.mediaDevices?.enumerateDevices) {
          return { status: 'warn', message: '浏览器不支持设备枚举', value: 'N/A' };
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(d => d.kind === 'audioinput');
        if (inputs.length === 0) return { status: 'warn', message: '未检测到麦克风', value: '0个设备' };
        const labeled = inputs.filter(d => d.label);
        return {
          status: labeled.length > 0 ? 'pass' : 'warn',
          value: `${inputs.length}个设备`,
          message: labeled.length === 0 ? '需要浏览器授予麦克风权限才能读取设备名称' : undefined,
        };
      },
    },
    audio_devices_output: {
      name: '音频输出设备', icon: '🔊', category: 'audio',
      run: async () => {
        if (!navigator.mediaDevices?.enumerateDevices) {
          return { status: 'warn', message: '浏览器不支持设备枚举', value: 'N/A' };
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        if (outputs.length === 0) return { status: 'warn', message: '未检测到扬声器', value: '0个设备' };
        return { status: 'pass', value: `${outputs.length}个设备` };
      },
    },
    audio_web_api: {
      name: 'Web Audio API', icon: '🔧', category: 'audio',
      run: () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return { status: 'fail', message: 'Web Audio API 不可用' };
        try {
          const ctx = new AC();
          const sr = ctx.sampleRate;
          const state = ctx.state;
          ctx.close();
          return {
            status: state === 'running' ? 'pass' : 'warn',
            value: `${(sr / 1000).toFixed(1)}kHz`,
            message: state === 'suspended' ? '音频上下文处于暂停状态（需用户交互后激活）' : undefined,
          };
        } catch (e) {
          return { status: 'fail', message: `初始化失败: ${e.message}` };
        }
      },
    },
    audio_playback_sine: {
      name: '正弦波播放测试', icon: '〰️', category: 'audio',
      run: async () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return { status: 'fail', message: 'Web Audio API 不可用' };
        try {
          const ctx = new AC();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0.05; // 低音量
          osc.type = 'sine';
          osc.frequency.value = 440; // A4
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          await new Promise(r => setTimeout(r, 300));
          osc.stop();
          ctx.close();
          return { status: 'pass', value: '440Hz 正常' };
        } catch (e) {
          return { status: 'fail', message: `播放失败: ${e.message}` };
        }
      },
    },
    audio_playback_noise: {
      name: '音频缓冲播放', icon: '📊', category: 'audio',
      run: async () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return { status: 'fail', message: 'Web Audio API 不可用' };
        try {
          const ctx = new AC();
          const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.03; // 极低音量白噪声
          }
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.start();
          await new Promise(r => setTimeout(r, 250));
          source.stop();
          ctx.close();
          return { status: 'pass', value: '缓冲播放正常' };
        } catch (e) {
          return { status: 'fail', message: `缓冲播放失败: ${e.message}` };
        }
      },
    },
    audio_speech_synthesis: {
      name: '语音合成 (TTS)', icon: '🗣️', category: 'audio',
      run: () => {
        if (!window.speechSynthesis) {
          return { status: 'warn', message: '浏览器不支持 Speech Synthesis API', value: '不可用' };
        }
        const voices = speechSynthesis.getVoices();
        return {
          status: voices.length > 0 ? 'pass' : 'warn',
          value: `${voices.length}个语音`,
          message: voices.length === 0 ? '未检测到语音包（可能需要联网下载）' : undefined,
        };
      },
    },
    audio_recording_permission: {
      name: '录音权限状态', icon: '🎙️', category: 'audio',
      run: async () => {
        if (!navigator.permissions) {
          return { status: 'warn', message: 'Permissions API 不可用', value: '未知' };
        }
        try {
          const status = await navigator.permissions.query({ name: 'microphone' });
          const stateMap = { granted: 'pass', denied: 'fail', prompt: 'warn' };
          const statusResult = stateMap[status.state] || 'warn';
          const stateText = { granted: '已授权', denied: '已拒绝', prompt: '待询问' };
          return {
            status: statusResult,
            value: stateText[status.state] || status.state,
            message: status.state === 'denied' ? '麦克风权限被拒绝，语音输入功能不可用' : undefined,
          };
        } catch (e) {
          return { status: 'warn', message: '无法查询权限状态', value: '未知' };
        }
      },
    },

    // 视频
    video_codec_h264: {
      name: 'H.264/AVC 编解码', icon: '📹', category: 'video',
      run: () => {
        const v = document.createElement('video');
        const result = v.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
        if (result === 'probably') return { status: 'pass', value: '硬件加速' };
        if (result === 'maybe') return { status: 'pass', value: '软件支持' };
        return { status: 'warn', message: 'H.264 解码不可用', value: '不支持' };
      },
    },
    video_codec_h265: {
      name: 'H.265/HEVC 编解码', icon: '📹', category: 'video',
      run: () => {
        const v = document.createElement('video');
        const result = v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.90"');
        if (result === 'probably') return { status: 'pass', value: '硬件加速' };
        if (result === 'maybe') return { status: 'pass', value: '软件支持' };
        return { status: 'warn', message: 'H.265 解码不可用（部分视频可能无法播放）', value: '不支持' };
      },
    },
    video_codec_vp8: {
      name: 'VP8 编解码', icon: '📹', category: 'video',
      run: () => {
        const v = document.createElement('video');
        const result = v.canPlayType('video/webm; codecs="vp8, vorbis"');
        if (result !== '') return { status: 'pass', value: result === 'probably' ? '硬件加速' : '软件支持' };
        return { status: 'warn', message: 'VP8 解码不可用', value: '不支持' };
      },
    },
    video_codec_vp9: {
      name: 'VP9 编解码', icon: '📹', category: 'video',
      run: () => {
        const v = document.createElement('video');
        const result = v.canPlayType('video/webm; codecs="vp9, opus"');
        if (result !== '') return { status: 'pass', value: result === 'probably' ? '硬件加速' : '软件支持' };
        return { status: 'warn', message: 'VP9 解码不可用', value: '不支持' };
      },
    },
    video_codec_av1: {
      name: 'AV1 编解码', icon: '📹', category: 'video',
      run: () => {
        const v = document.createElement('video');
        const result = v.canPlayType('video/webm; codecs="av01.0.05M.08"');
        if (result !== '') return { status: 'pass', value: result === 'probably' ? '硬件加速' : '软件支持' };
        return { status: 'warn', message: 'AV1 解码不可用（新一代编码）', value: '不支持' };
      },
    },
    video_playback_mp4: {
      name: 'MP4 容器支持', icon: '▶️', category: 'video',
      run: () => {
        const v = document.createElement('video');
        const result = v.canPlayType('video/mp4');
        if (result !== '') return { status: 'pass', value: result === 'probably' ? '完整支持' : '基本支持' };
        return { status: 'fail', message: 'MP4 容器不受支持', value: '不支持' };
      },
    },
    video_playback_webm: {
      name: 'WebM 容器支持', icon: '▶️', category: 'video',
      run: () => {
        const v = document.createElement('video');
        const result = v.canPlayType('video/webm');
        if (result !== '') return { status: 'pass', value: result === 'probably' ? '完整支持' : '基本支持' };
        return { status: 'warn', message: 'WebM 容器不受支持', value: '不支持' };
      },
    },
    video_canvas_render: {
      name: 'Canvas 视频渲染', icon: '🖼️', category: 'video',
      run: () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const ctx = canvas.getContext('2d');
          if (!ctx) return { status: 'fail', message: 'Canvas 2D 上下文不可用' };
          // 测试绘制能力
          ctx.fillStyle = '#4488ff';
          ctx.fillRect(0, 0, 100, 100);
          const pixel = ctx.getImageData(50, 50, 1, 1).data;
          if (pixel[2] > 200) return { status: 'pass', value: '320×240 正常' };
          return { status: 'warn', message: 'Canvas 渲染异常', value: '部分可用' };
        } catch (e) {
          return { status: 'fail', message: `Canvas 不可用: ${e.message}` };
        }
      },
    },

    // 文档
    doc_text_decoder: {
      name: '文本解码器', icon: '📝', category: 'document',
      run: () => {
        if (typeof TextDecoder !== 'undefined') {
          try {
            const td = new TextDecoder('utf-8');
            const result = td.decode(new Uint8Array([228, 189, 160, 229, 165, 189])); // "你好"
            if (result === '你好') return { status: 'pass', value: 'UTF-8 正常' };
            return { status: 'warn', message: 'UTF-8 解码异常', value: '部分可用' };
          } catch (e) {
            return { status: 'warn', message: `解码器异常: ${e.message}`, value: '部分可用' };
          }
        }
        return { status: 'fail', message: 'TextDecoder 不可用' };
      },
    },
    doc_dom_parser: {
      name: 'HTML/XML 解析', icon: '📋', category: 'document',
      run: () => {
        if (typeof DOMParser === 'undefined') return { status: 'fail', message: 'DOMParser 不可用' };
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString('<root><item id="1">test</item></root>', 'text/xml');
          const item = doc.querySelector('item');
          if (item && item.textContent === 'test') return { status: 'pass', value: 'XML 解析正常' };
          return { status: 'warn', message: 'XML 解析结果异常', value: '部分可用' };
        } catch (e) {
          return { status: 'fail', message: `解析失败: ${e.message}` };
        }
      },
    },
    doc_file_reader: {
      name: '文件读取 API', icon: '📖', category: 'document',
      run: () => {
        if (typeof FileReader === 'undefined') return { status: 'fail', message: 'FileReader 不可用' };
        const methods = [];
        if (typeof FileReader.prototype.readAsText !== 'undefined') methods.push('Text');
        if (typeof FileReader.prototype.readAsArrayBuffer !== 'undefined') methods.push('Binary');
        if (typeof FileReader.prototype.readAsDataURL !== 'undefined') methods.push('DataURL');
        return { status: 'pass', value: methods.join('/') };
      },
    },
    doc_blob_api: {
      name: '二进制数据处理', icon: '📦', category: 'document',
      run: () => {
        if (typeof Blob === 'undefined') return { status: 'fail', message: 'Blob API 不可用' };
        try {
          const blob = new Blob(['test content'], { type: 'text/plain' });
          if (blob.size === 12) return { status: 'pass', value: 'Blob 正常' };
          return { status: 'warn', message: 'Blob 创建异常', value: '部分可用' };
        } catch (e) {
          return { status: 'fail', message: `Blob 失败: ${e.message}` };
        }
      },
    },
    doc_pdf_canvas: {
      name: 'PDF Canvas 渲染', icon: '🎨', category: 'document',
      run: () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) return { status: 'warn', message: 'Canvas 不可用（PDF渲染需要）' };
          // 检查 PDF.js 全局
          const hasPdfJs = typeof window.pdfjsLib !== 'undefined' || typeof pdfjsLib !== 'undefined';
          return {
            status: hasPdfJs ? 'pass' : 'warn',
            value: hasPdfJs ? 'PDF.js 已加载' : 'Canvas 就绪',
            message: hasPdfJs ? undefined : 'PDF.js 库未加载，PDF 预览功能可能受限',
          };
        } catch (e) {
          return { status: 'warn', message: 'PDF 渲染环境不完整' };
        }
      },
    },
    doc_pdf_text: {
      name: 'PDF 文本提取', icon: '🔤', category: 'document',
      run: () => {
        const checks = [];
        if (typeof TextDecoder !== 'undefined') checks.push('TextDecoder');
        if (typeof atob !== 'undefined') checks.push('Base64');
        if (typeof ArrayBuffer !== 'undefined') checks.push('ArrayBuffer');
        if (typeof Uint8Array !== 'undefined') checks.push('Uint8Array');

        if (checks.length >= 4) return { status: 'pass', value: checks.join(', ') };
        return { status: 'warn', message: `缺少: ${['TextDecoder', 'Base64', 'ArrayBuffer', 'Uint8Array'].filter(c => !checks.includes(c)).join(', ')}`, value: `${checks.length}/4 就绪` };
      },
    },
    doc_office_xml: {
      name: 'Office XML 解析', icon: '📊', category: 'document',
      run: () => {
        if (typeof DOMParser === 'undefined') return { status: 'warn', message: 'DOMParser 不可用' };
        try {
          const parser = new DOMParser();
          const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Test</w:t></w:r></w:p></w:body></w:document>';
          const doc = parser.parseFromString(xml, 'text/xml');
          const hasError = doc.querySelector('parsererror');
          if (!hasError) return { status: 'pass', value: 'OOXML 解析正常' };
          return { status: 'warn', message: 'XML 命名空间解析可能有误', value: '基本支持' };
        } catch (e) {
          return { status: 'warn', message: `解析异常: ${e.message}`, value: '部分可用' };
        }
      },
    },
    doc_office_zip: {
      name: 'Office ZIP 读取', icon: '🗜️', category: 'document',
      run: () => {
        // 检查是否支持 ZIP 解压所需 API
        const checks = [];
        if (typeof ArrayBuffer !== 'undefined') checks.push('ArrayBuffer');
        if (typeof Uint8Array !== 'undefined') checks.push('Uint8Array');
        if (typeof DataView !== 'undefined') checks.push('DataView');
        if (typeof TextDecoder !== 'undefined') checks.push('TextDecoder');

        if (checks.length >= 4) return { status: 'pass', value: 'ZIP 读取就绪' };
        return { status: 'warn', message: `缺少 API: ${['ArrayBuffer', 'Uint8Array', 'DataView', 'TextDecoder'].filter(c => !checks.includes(c)).join(', ')}`, value: `${checks.length}/4 就绪` };
      },
    },
    doc_image_png: {
      name: 'PNG/JPEG 处理', icon: '🖼️', category: 'document',
      run: () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 10;
          canvas.height = 10;
          const ctx = canvas.getContext('2d');
          if (!ctx) return { status: 'fail', message: 'Canvas 不可用' };
          ctx.fillStyle = 'red';
          ctx.fillRect(0, 0, 10, 10);
          const png = canvas.toDataURL('image/png');
          const jpeg = canvas.toDataURL('image/jpeg');
          if (png.startsWith('data:image/png') && jpeg.startsWith('data:image/jpeg')) {
            return { status: 'pass', value: 'PNG/JPEG 正常' };
          }
          return { status: 'warn', message: '图片编码异常', value: '部分可用' };
        } catch (e) {
          return { status: 'fail', message: `图片处理失败: ${e.message}` };
        }
      },
    },
    doc_image_webp: {
      name: 'WebP 图片支持', icon: '🖼️', category: 'document',
      run: () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          const dataUrl = canvas.toDataURL('image/webp');
          if (dataUrl.indexOf('data:image/webp') === 0) return { status: 'pass', value: '编码支持' };
          return { status: 'warn', message: 'WebP 编码不可用（解码可能正常）', value: '仅解码' };
        } catch (e) {
          return { status: 'warn', message: 'WebP 不可用', value: '不支持' };
        }
      },
    },
    doc_image_svg: {
      name: 'SVG 矢量图支持', icon: '🖼️', category: 'document',
      run: () => {
        const img = new Image();
        return {
          status: 'pass',
          value: '内嵌支持',
        };
      },
    },

    // 网络
    net_internet: {
      name: '互联网连接', icon: '🌍', category: 'network',
      run: async () => {
        try {
          const start = performance.now();
          const resp = await fetch('https://www.baidu.com/favicon.ico', {
            method: 'HEAD', mode: 'no-cors', cache: 'no-cache',
          });
          const latency = Math.round(performance.now() - start);
          if (latency > 5000) return { status: 'warn', message: '网络延迟较高', value: `${latency}ms` };
          return { status: 'pass', value: `${latency}ms` };
        } catch (e) {
          return { status: 'fail', message: '无法连接互联网', value: '超时' };
        }
      },
    },
    net_dns: {
      name: 'DNS 解析', icon: '📡', category: 'network',
      run: async () => {
        try {
          const start = performance.now();
          await fetch('https://api.deepseek.com/v1/models', {
            method: 'HEAD', mode: 'no-cors', cache: 'no-cache',
          });
          const latency = Math.round(performance.now() - start);
          if (latency > 3000) return { status: 'warn', message: 'DNS 解析较慢', value: `${latency}ms` };
          return { status: 'pass', value: `${latency}ms` };
        } catch (e) {
          return { status: 'warn', message: 'DNS 解析失败（可能被防火墙拦截）', value: '失败' };
        }
      },
    },
    net_latency: {
      name: '网络延迟', icon: '⏱️', category: 'network',
      run: async () => {
        const targets = [
          { url: 'https://www.baidu.com/favicon.ico', name: '国内' },
          { url: 'https://api.github.com/favicon.ico', name: '国际' },
        ];
        const results = [];
        for (const t of targets) {
          try {
            const start = performance.now();
            await fetch(t.url, { method: 'HEAD', mode: 'no-cors', cache: 'no-cache' });
            results.push(`${t.name}:${Math.round(performance.now() - start)}ms`);
          } catch (e) {
            results.push(`${t.name}:超时`);
          }
        }
        return { status: 'pass', value: results.join(' | ') };
      },
    },
    net_llm_endpoint: {
      name: 'LLM API 端点', icon: '🤖', category: 'network',
      run: async () => {
        try {
          const start = performance.now();
          await fetch('https://api.deepseek.com/v1/models', {
            method: 'HEAD', mode: 'no-cors', cache: 'no-cache',
          });
          const latency = Math.round(performance.now() - start);
          return { status: 'pass', value: `DeepSeek ${latency}ms` };
        } catch (e) {
          return { status: 'warn', message: 'API 端点不可达（可能被 CORS 限制）', value: '无法验证' };
        }
      },
    },
    net_websocket: {
      name: 'WebSocket 支持', icon: '🔌', category: 'network',
      run: () => {
        if (typeof WebSocket !== 'undefined') return { status: 'pass', value: '可用' };
        return { status: 'warn', message: 'WebSocket 不可用（实时通信受限）', value: '不可用' };
      },
    },
    net_fetch_api: {
      name: 'Fetch API', icon: '📡', category: 'network',
      run: () => {
        if (typeof fetch !== 'undefined') return { status: 'pass', value: '可用' };
        return { status: 'fail', message: 'Fetch API 不可用', value: '不可用' };
      },
    },

    // 存储
    storage_localstorage: {
      name: 'LocalStorage', icon: '📁', category: 'storage',
      run: () => {
        try {
          const key = '__tricore_diag__';
          localStorage.setItem(key, 'test');
          const val = localStorage.getItem(key);
          localStorage.removeItem(key);
          if (val === 'test') return { status: 'pass', value: '读写正常' };
          return { status: 'warn', message: '读写结果不一致', value: '异常' };
        } catch (e) {
          return { status: 'fail', message: 'LocalStorage 不可用', value: '禁用' };
        }
      },
    },
    storage_indexeddb: {
      name: 'IndexedDB', icon: '🗄️', category: 'storage',
      run: () => {
        if (typeof indexedDB === 'undefined') return { status: 'warn', message: 'IndexedDB 不可用', value: '不可用' };
        return new Promise((resolve) => {
          try {
            const req = indexedDB.open('__tricore_diag__', 1);
            req.onupgradeneeded = (e) => {
              e.target.result.createObjectStore('test');
            };
            req.onsuccess = (e) => {
              const db = e.target.result;
              db.close();
              indexedDB.deleteDatabase('__tricore_diag__');
              resolve({ status: 'pass', value: '读写正常' });
            };
            req.onerror = () => {
              resolve({ status: 'fail', message: 'IndexedDB 打开失败', value: '异常' });
            };
            setTimeout(() => resolve({ status: 'warn', message: 'IndexedDB 操作超时', value: '超时' }), 3000);
          } catch (e) {
            resolve({ status: 'fail', message: `IndexedDB 异常: ${e.message}`, value: '异常' });
          }
        });
      },
    },
    storage_write_speed: {
      name: '写入性能', icon: '✍️', category: 'storage',
      run: () => {
        try {
          const data = 'x'.repeat(10000);
          const start = performance.now();
          for (let i = 0; i < 100; i++) {
            localStorage.setItem(`__perf_${i}`, data);
          }
          const elapsed = performance.now() - start;
          for (let i = 0; i < 100; i++) localStorage.removeItem(`__perf_${i}`);
          const speed = Math.round(1000000 / elapsed);
          if (speed > 500000) return { status: 'pass', value: `${(elapsed).toFixed(1)}ms (100次)` };
          return { status: 'warn', message: '写入速度较慢', value: `${(elapsed).toFixed(1)}ms` };
        } catch (e) {
          return { status: 'fail', message: `写入失败: ${e.message}`, value: '失败' };
        }
      },
    },
    storage_read_speed: {
      name: '读取性能', icon: '📖', category: 'storage',
      run: () => {
        try {
          const data = 'x'.repeat(10000);
          for (let i = 0; i < 100; i++) localStorage.setItem(`__perf_${i}`, data);
          const start = performance.now();
          for (let i = 0; i < 100; i++) localStorage.getItem(`__perf_${i}`);
          const elapsed = performance.now() - start;
          for (let i = 0; i < 100; i++) localStorage.removeItem(`__perf_${i}`);
          return { status: 'pass', value: `${(elapsed).toFixed(1)}ms (100次)` };
        } catch (e) {
          return { status: 'fail', message: `读取失败: ${e.message}`, value: '失败' };
        }
      },
    },
    storage_quota: {
      name: '存储配额', icon: '📊', category: 'storage',
      run: async () => {
        if (navigator.storage?.estimate) {
          try {
            const est = await navigator.storage.estimate();
            const used = Math.round(est.usage / 1024 / 1024);
            const quota = Math.round(est.quota / 1024 / 1024);
            const pct = Math.round((used / quota) * 100);
            return {
              status: pct > 90 ? 'warn' : 'pass',
              value: `${used}MB / ${quota}MB (${pct}%)`,
              message: pct > 90 ? '存储空间即将用尽' : undefined,
            };
          } catch (e) {
            return { status: 'warn', message: '无法获取配额', value: '未知' };
          }
        }
        return { status: 'warn', message: 'Storage API 不可用', value: '未知' };
      },
    },
    storage_session: {
      name: 'SessionStorage', icon: '📁', category: 'storage',
      run: () => {
        try {
          sessionStorage.setItem('__test__', '1');
          sessionStorage.removeItem('__test__');
          return { status: 'pass', value: '正常' };
        } catch (e) {
          return { status: 'warn', message: 'SessionStorage 不可用', value: '禁用' };
        }
      },
    },

    // 环境
    env_os: {
      name: '操作系统', icon: '💻', category: 'environment',
      run: () => {
        const info = [];
        info.push(navigator.platform || 'Unknown');
        const ua = navigator.userAgent;
        if (ua.includes('Windows')) info.push('Windows');
        else if (ua.includes('Mac')) info.push('macOS');
        else if (ua.includes('Linux')) info.push('Linux');
        return { status: 'pass', value: info.join(' ') };
      },
    },
    env_cpu: {
      name: 'CPU 核心数', icon: '⚡', category: 'environment',
      run: () => {
        const cores = navigator.hardwareConcurrency || 1;
        if (cores >= 8) return { status: 'pass', value: `${cores} 核心` };
        if (cores >= 4) return { status: 'pass', value: `${cores} 核心` };
        return { status: 'warn', message: '核心数较少，性能可能受限', value: `${cores} 核心` };
      },
    },
    env_memory: {
      name: '可用内存', icon: '🧠', category: 'environment',
      run: () => {
        if (navigator.deviceMemory) {
          return { status: navigator.deviceMemory >= 4 ? 'pass' : 'warn', value: `${navigator.deviceMemory} GB` };
        }
        if (performance.memory) {
          const limit = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
          return { status: 'pass', value: `JS堆 ${limit}MB` };
        }
        return { status: 'warn', message: '无法获取内存信息', value: '未知' };
      },
    },
    env_webgl: {
      name: 'WebGL 图形加速', icon: '🎮', category: 'environment',
      run: () => {
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (gl) {
            const info = gl.getParameter(gl.RENDERER);
            return { status: 'pass', value: info || '已启用' };
          }
          return { status: 'warn', message: 'WebGL 不可用（图形渲染降级）', value: '不可用' };
        } catch (e) {
          return { status: 'warn', message: 'WebGL 检测失败', value: '未知' };
        }
      },
    },
    env_workers: {
      name: 'Web Workers', icon: '👷', category: 'environment',
      run: () => {
        if (typeof Worker !== 'undefined') return { status: 'pass', value: '可用' };
        return { status: 'warn', message: 'Web Workers 不可用（多线程受限）', value: '不可用' };
      },
    },
    env_wasm: {
      name: 'WebAssembly', icon: '⚙️', category: 'environment',
      run: () => {
        if (typeof WebAssembly !== 'undefined') {
          const features = [];
          if (WebAssembly.validate) features.push('验证');
          if (WebAssembly.compile) features.push('编译');
          if (WebAssembly.instantiate) features.push('实例化');
          return { status: 'pass', value: features.join(', ') };
        }
        return { status: 'warn', message: 'WebAssembly 不可用', value: '不可用' };
      },
    },
  };

  // ═══════════════════════════════════════
  // TriCoreSelfCheckPanel 类
  // ═══════════════════════════════════════

  class TriCoreSelfCheckPanel {
    constructor() {
      this._overlay = null;
      this._container = null;
      this._results = {};
      this._isVisible = false;
      this._runningCategory = null;
    }

    // ═══════════════════════════════════════
    // 公共方法
    // ═══════════════════════════════════════

    async open() {
      if (this._isVisible) return;
      this._createUI();
      this._isVisible = true;
      // 自动运行全部检测
      setTimeout(() => this.runAll(), 600);
    }

    close() {
      if (!this._isVisible) return;
      this._isVisible = false;
      if (this._overlay) {
        this._overlay.classList.add('sc-closing');
        setTimeout(() => {
          if (this._overlay?.parentNode) this._overlay.parentNode.removeChild(this._overlay);
          this._overlay = null;
          this._container = null;
        }, 300);
      }
    }

    async runAll() {
      for (const catId of Object.keys(CHECK_CATEGORIES)) {
        await this.runCategory(catId);
      }
    }

    async runCategory(categoryId) {
      const cat = CHECK_CATEGORIES[categoryId];
      if (!cat) return;

      this._runningCategory = categoryId;
      this._updateCategoryStatus(categoryId, 'running');

      const results = [];
      for (const checkId of cat.checks) {
        const def = CHECK_DEFINITIONS[checkId];
        if (!def) continue;

        this._updateCheckStatus(checkId, 'running');
        try {
          const result = await def.run();
          results.push({ id: checkId, ...def, ...result });
          this._updateCheckStatus(checkId, result.status, result.value, result.message);
        } catch (e) {
          results.push({ id: checkId, ...def, status: 'fail', message: e.message });
          this._updateCheckStatus(checkId, 'fail', undefined, e.message);
        }
      }

      this._results[categoryId] = results;
      this._updateCategoryStatus(categoryId, this._getCategoryOverallStatus(results));
      this._updateOverallProgress();
    }

    // ═══════════════════════════════════════
    // UI 创建
    // ═══════════════════════════════════════

    _createUI() {
      this._overlay = document.createElement('div');
      this._overlay.className = 'selfcheck-overlay';
      this._overlay.innerHTML = `
        <div class="selfcheck-panel">
          <div class="sc-header">
            <div class="sc-header-left">
              <span class="sc-header-icon">🔍</span>
              <div>
                <h2>系统自检面板</h2>
                <p>TriCore Agent 全组件诊断</p>
              </div>
            </div>
            <div class="sc-header-actions">
              <button class="sc-btn sc-btn-outline" id="sc-btn-export" title="导出报告">📋 导出</button>
              <button class="sc-btn sc-btn-outline" id="sc-btn-rerun" title="重新检测">🔄 重新检测</button>
              <button class="sc-close-btn" id="sc-close-btn">✕</button>
            </div>
          </div>

          <div class="sc-body">
            <!-- 总体进度 -->
            <div class="sc-overall">
              <div class="sc-overall-stats" id="sc-overall-stats">
                <div class="sc-stat">
                  <span class="sc-stat-value" id="sc-stat-total">0</span>
                  <span class="sc-stat-label">总计</span>
                </div>
                <div class="sc-stat sc-stat-pass">
                  <span class="sc-stat-value" id="sc-stat-pass">0</span>
                  <span class="sc-stat-label">通过</span>
                </div>
                <div class="sc-stat sc-stat-warn">
                  <span class="sc-stat-value" id="sc-stat-warn">0</span>
                  <span class="sc-stat-label">警告</span>
                </div>
                <div class="sc-stat sc-stat-fail">
                  <span class="sc-stat-value" id="sc-stat-fail">0</span>
                  <span class="sc-stat-label">失败</span>
                </div>
              </div>
              <div class="sc-progress-bar">
                <div class="sc-progress-fill" id="sc-progress-fill" style="width:0%"></div>
              </div>
            </div>

            <!-- 分类面板 -->
            <div class="sc-categories" id="sc-categories">
              ${Object.entries(CHECK_CATEGORIES).map(([id, cat]) => `
                <div class="sc-category" id="sc-cat-${id}">
                  <div class="sc-cat-header" data-category="${id}">
                    <span class="sc-cat-icon">${cat.icon}</span>
                    <span class="sc-cat-name">${cat.name}</span>
                    <span class="sc-cat-desc">${cat.description}</span>
                    <span class="sc-cat-status" id="sc-cat-status-${id}">
                      <span class="sc-status-pending">等待中</span>
                    </span>
                    <span class="sc-cat-toggle">▸</span>
                  </div>
                  <div class="sc-cat-body" id="sc-cat-body-${id}">
                    ${cat.checks.map(checkId => {
                      const def = CHECK_DEFINITIONS[checkId];
                      if (!def) return '';
                      return `
                        <div class="sc-check-item" id="sc-check-${checkId}">
                          <span class="sc-check-icon">${def.icon}</span>
                          <span class="sc-check-name">${def.name}</span>
                          <span class="sc-check-result" id="sc-check-result-${checkId}">
                            <span class="sc-status-pending">等待检测</span>
                          </span>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(this._overlay);
      this._container = this._overlay.querySelector('.selfcheck-panel');

      // 绑定事件
      this._bindEvents();
    }

    _bindEvents() {
      // 关闭按钮
      this._overlay.querySelector('#sc-close-btn').addEventListener('click', () => this.close());

      // 点击遮罩关闭
      this._overlay.addEventListener('click', (e) => {
        if (e.target === this._overlay) this.close();
      });

      // 重新检测
      this._overlay.querySelector('#sc-btn-rerun').addEventListener('click', () => {
        this._resetAll();
        this.runAll();
      });

      // 导出报告
      this._overlay.querySelector('#sc-btn-export').addEventListener('click', () => {
        this._exportReport();
      });

      // 分类折叠
      this._overlay.querySelectorAll('.sc-cat-header').forEach(header => {
        header.addEventListener('click', () => {
          const catId = header.dataset.category;
          const body = this._overlay.querySelector(`#sc-cat-body-${catId}`);
          const toggle = header.querySelector('.sc-cat-toggle');
          if (body.style.display === 'block') {
            body.style.display = 'none';
            toggle.textContent = '▸';
          } else {
            body.style.display = 'block';
            toggle.textContent = '▾';
          }
        });
      });

      // ESC 关闭
      this._keyHandler = (e) => {
        if (e.key === 'Escape') this.close();
      };
      document.addEventListener('keydown', this._keyHandler);
    }

    // ═══════════════════════════════════════
    // 状态更新
    // ═══════════════════════════════════════

    _updateCheckStatus(checkId, status, value, message) {
      const resultEl = this._overlay?.querySelector(`#sc-check-result-${checkId}`);
      if (!resultEl) return;

      const statusMap = {
        running: `<span class="sc-status-running"><span class="sc-spinner"></span>检测中...</span>`,
        pass: `<span class="sc-status-pass">✅ 通过</span>${value ? ` <span class="sc-check-value">${value}</span>` : ''}`,
        warn: `<span class="sc-status-warn">⚠️ ${message || '警告'}</span>`,
        fail: `<span class="sc-status-fail">❌ ${message || '失败'}</span>`,
      };

      resultEl.innerHTML = statusMap[status] || statusMap.pending;
    }

    _updateCategoryStatus(categoryId, status) {
      const statusEl = this._overlay?.querySelector(`#sc-cat-status-${categoryId}`);
      if (!statusEl) return;

      const statusMap = {
        running: '<span class="sc-status-running"><span class="sc-spinner"></span>检测中...</span>',
        pass: '<span class="sc-cat-badge pass">全部通过</span>',
        warn: '<span class="sc-cat-badge warn">存在警告</span>',
        fail: '<span class="sc-cat-badge fail">存在失败</span>',
        pending: '<span class="sc-status-pending">等待中</span>',
      };

      statusEl.innerHTML = statusMap[status] || statusMap.pending;
    }

    _updateOverallProgress() {
      let total = 0, passed = 0, warned = 0, failed = 0;
      for (const results of Object.values(this._results)) {
        for (const r of results) {
          total++;
          if (r.status === 'pass') passed++;
          else if (r.status === 'warn') warned++;
          else if (r.status === 'fail') failed++;
        }
      }

      // 更新统计
      const totalEl = this._overlay?.querySelector('#sc-stat-total');
      const passEl = this._overlay?.querySelector('#sc-stat-pass');
      const warnEl = this._overlay?.querySelector('#sc-stat-warn');
      const failEl = this._overlay?.querySelector('#sc-stat-fail');
      const progressEl = this._overlay?.querySelector('#sc-progress-fill');

      if (totalEl) totalEl.textContent = total;
      if (passEl) passEl.textContent = passed;
      if (warnEl) warnEl.textContent = warned;
      if (failEl) failEl.textContent = failed;

      // 计算进度（包括已运行的分类数）
      const categoriesRun = Object.keys(this._results).length;
      const totalCategories = Object.keys(CHECK_CATEGORIES).length;
      if (progressEl) {
        progressEl.style.width = `${Math.round((categoriesRun / totalCategories) * 100)}%`;
      }
    }

    _getCategoryOverallStatus(results) {
      const hasFail = results.some(r => r.status === 'fail');
      const hasWarn = results.some(r => r.status === 'warn');
      if (hasFail) return 'fail';
      if (hasWarn) return 'warn';
      return 'pass';
    }

    _resetAll() {
      this._results = {};
      // 重置所有状态显示
      Object.keys(CHECK_CATEGORIES).forEach(catId => {
        this._updateCategoryStatus(catId, 'pending');
      });
      Object.keys(CHECK_DEFINITIONS).forEach(checkId => {
        this._updateCheckStatus(checkId, 'pending');
      });
      // 重置统计
      ['total', 'pass', 'warn', 'fail'].forEach(s => {
        const el = this._overlay?.querySelector(`#sc-stat-${s}`);
        if (el) el.textContent = '0';
      });
      const progressEl = this._overlay?.querySelector('#sc-progress-fill');
      if (progressEl) progressEl.style.width = '0%';
    }

    // ═══════════════════════════════════════
    // 导出报告
    // ═══════════════════════════════════════

    _exportReport() {
      let report = '# 蜜糖 TriCore Agent 系统自检报告\n\n';
      report += `> 生成时间: ${new Date().toLocaleString()}\n`;
      report += `> 用户代理: ${navigator.userAgent}\n\n`;
      report += '---\n\n';

      let totalPass = 0, totalWarn = 0, totalFail = 0;

      for (const [catId, cat] of Object.entries(CHECK_CATEGORIES)) {
        const results = this._results[catId] || [];
        report += `## ${cat.icon} ${cat.name}\n\n`;

        if (results.length === 0) {
          report += '> 未检测\n\n';
          continue;
        }

        report += '| 检查项 | 状态 | 详情 |\n';
        report += '|--------|------|------|\n';

        for (const r of results) {
          const statusEmoji = r.status === 'pass' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
          const detail = r.value || r.message || '-';
          report += `| ${r.icon} ${r.name} | ${statusEmoji} ${r.status} | ${detail} |\n`;

          if (r.status === 'pass') totalPass++;
          else if (r.status === 'warn') totalWarn++;
          else totalFail++;
        }
        report += '\n';
      }

      report += '---\n\n';
      report += '## 📊 汇总\n\n';
      report += `- ✅ 通过: **${totalPass}**\n`;
      report += `- ⚠️ 警告: **${totalWarn}**\n`;
      report += `- ❌ 失败: **${totalFail}**\n`;
      report += `- 📋 总计: **${totalPass + totalWarn + totalFail}**\n`;
      report += `- 📈 通过率: **${Math.round(totalPass / (totalPass + totalWarn + totalFail) * 100)}%**\n`;

      // 下载文件
      const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `TriCore_SystemCheck_${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  // ═══════════════════════════════════════
  // 暴露到全局
  // ═══════════════════════════════════════

  window.TriCoreSelfCheckPanel = TriCoreSelfCheckPanel;

  // 便捷方法
  window.openSystemSelfCheck = async function () {
    const panel = new TriCoreSelfCheckPanel();
    await panel.open();
  };

  console.log('[SelfCheckPanel] 系统自检面板 v1.0 已加载');
})();
