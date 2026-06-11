/**
 * Type declarations for ApiServer — HTTP API 服务层
 *
 * 入口: src/api/api-server.js
 *
 * 提供 HTTP + SSE + WebSocket 接口。
 * 路由已模块化到 src/api/routes/ 目录。
 */

declare module 'mitang-tricore-agent' {
  import { EventEmitter } from 'events';
  import http from 'http';

  // ── 构造选项 ──
  interface ApiServerOptions {
    port?: number;
    host?: string;
    agent?: unknown;
    apiToken?: string;
    allowLan?: boolean;
    apiVersion?: string;
    codename?: string;
    brandName?: string;
  }

  // ── 状态 ──
  interface ApiServerStatus {
    running: boolean;
    port: number;
    host: string;
    apiVersion: string;
    sseClients: number;
    wsClients: number;
    allowLan: boolean;
    version: string;
    endpoints: string[];
  }

  // ── 路由处理器 ──
  type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>;

  // ── 主类 ──
  class ApiServer extends EventEmitter {
    constructor(options?: ApiServerOptions);

    /** 启动 HTTP 服务器 */
    start(): Promise<void>;

    /** 停止服务器 */
    stop(): void;

    /** SSE 事件广播 */
    broadcastEvent(eventType: string, data: unknown): void;

    /** WebSocket 频道广播 */
    broadcastWs(channel: string, data: unknown): void;

    /** 获取状态 */
    getStatus(): ApiServerStatus;

    /** 事件: started */
    on(event: 'started', listener: (data: { port: number; host: string }) => void): this;
    /** 事件: ws:connected */
    on(event: 'ws:connected', listener: (data: { clientId: string }) => void): this;
  }

  export { ApiServer };
}
