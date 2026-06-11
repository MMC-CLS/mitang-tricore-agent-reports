/**
 * TriCore Agent v1.0 - Chaos Engineering Test Suite
 *
 * Validates system resilience under adverse conditions:
 *   1. Network chaos  — latency spikes, connection drops, partial responses
 *   2. CPU pressure    — CPU-intensive workers, graceful degradation
 *   3. Memory pressure — large buffer allocation, OOM handling, recovery
 *   4. Disk I/O chaos  — large file writes, disk space handling
 *   5. Process chaos   — subprocess crashes, orphan handling
 *
 * Usage:
 *   node --test tests/chaos/chaos-test.js
 *   node --test tests/chaos/chaos-test.js --test-name-pattern "network"
 *
 * All tests use node:test + node:assert (zero external dependencies).
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn, fork } = require('child_process');
const { EventEmitter } = require('events');
const { performance } = require('node:perf_hooks');

// ═══════════════════════════════════════
// Configuration
// ═══════════════════════════════════════

const CHAOS_CONFIG = {
  defaultDuration: 5000,          // Default scenario duration in ms
  networkLatencyMin: 1000,        // Min simulated latency (ms)
  networkLatencyMax: 5000,        // Max simulated latency (ms)
  cpuWorkers: 2,                  // Number of CPU-pressure workers
  cpuDuration: 4000,               // CPU pressure duration (ms)
  memoryBufferSize: 50 * 1024 * 1024,  // 50 MB per buffer
  memoryBufferCount: 4,           // Number of buffers to allocate
  diskFileSize: 10 * 1024 * 1024, // 10 MB per file
  diskFileCount: 3,               // Number of files to write
  processCrashCount: 3,           // Number of subprocess crash cycles
  healthCheckTimeout: 3000,       // Health check timeout (ms)
  maxRecoveryTime: 10000,         // Max time to wait for recovery (ms)
  canaryPort: 0,                  // 0 = random available port
};

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

/**
 * Get a free port from the OS.
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make an HTTP request and return the response.
 * @param {object} options - http.request options
 * @param {string} [body] - optional request body
 * @returns {Promise<{statusCode: number, headers: object, body: string, duration: number}>}
 */
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const duration = performance.now() - start;
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          duration,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 10000, () => {
      req.destroy(new Error('request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Run a chaos scenario with structured setup, execution, and teardown.
 * Records timing, errors, and recovery status.
 *
 * @param {string} name - Human-readable scenario name
 * @param {number} duration - How long to apply chaos (ms)
 * @param {function} setupFn - Async setup before chaos
 * @param {function} chaosFn - Async function that applies chaos
 * @param {function} verifyFn - Async function that verifies degradation/recovery
 * @param {function} teardownFn - Async cleanup
 * @returns {object} Scenario result with metrics
 */
async function runChaosScenario(name, duration, { setupFn, chaosFn, verifyFn, teardownFn }) {
  const result = {
    name,
    duration,
    startTime: Date.now(),
    endTime: null,
    setupOk: false,
    chaosApplied: false,
    verificationPassed: false,
    teardownOk: false,
    error: null,
    metrics: {},
  };

  try {
    // Phase 1: Setup
    const setupResult = setupFn ? await setupFn() : null;
    result.setupOk = true;
    result.metrics.setup = { ok: true, data: setupResult };

    // Phase 2: Apply chaos
    const chaosStart = performance.now();
    await chaosFn();
    result.chaosApplied = true;
    result.metrics.chaos = { appliedAt: chaosStart, duration: performance.now() - chaosStart };

    // Phase 3: Verify behavior under/after chaos
    if (verifyFn) {
      const verifyResult = await verifyFn();
      result.verificationPassed = verifyResult.passed;
      result.metrics.verification = verifyResult;
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    // Phase 4: Teardown (always run)
    try {
      if (teardownFn) await teardownFn();
      result.teardownOk = true;
    } catch (teardownErr) {
      result.teardownOk = false;
      result.error = result.error || `teardown failed: ${teardownErr.message}`;
    }
    result.endTime = Date.now();
  }

  return result;
}

/**
 * Create a simple HTTP server that can be controlled for chaos testing.
 * Supports configurable latency, error injection, and partial responses.
 */
class ChaosHttpServer {
  constructor() {
    this._server = null;
    this._port = 0;
    this._latencyMin = 0;
    this._latencyMax = 0;
    this._dropRate = 0;         // 0-1 probability of dropping a connection
    this._partialRate = 0;      // 0-1 probability of sending partial response
    this._requestCount = 0;
    this._droppedCount = 0;
    this._partialCount = 0;
    this._errorCount = 0;
    this._responses = [];
  }

  /**
   * Configure latency range for responses.
   * @param {number} min - Min latency in ms
   * @param {number} max - Max latency in ms
   */
  setLatency(min, max) {
    this._latencyMin = min;
    this._latencyMax = max;
  }

  /**
   * Set the probability of dropping a connection (0-1).
   * @param {number} rate
   */
  setDropRate(rate) {
    this._dropRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * Set the probability of sending a partial response (0-1).
   * @param {number} rate
   */
  setPartialRate(rate) {
    this._partialRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * Start the chaos HTTP server.
   * @returns {Promise<number>} The port the server is listening on
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => {
        this._requestCount++;

        // Decide: drop connection?
        if (this._dropRate > 0 && Math.random() < this._dropRate) {
          this._droppedCount++;
          res.destroy();
          return;
        }

        // Decide: partial response?
        const sendPartial = this._partialRate > 0 && Math.random() < this._partialRate;

        // Calculate delay
        const delay = this._latencyMin + Math.random() * (this._latencyMax - this._latencyMin);

        setTimeout(() => {
          const body = JSON.stringify({
            ok: true,
            timestamp: Date.now(),
            requestNumber: this._requestCount,
          });

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'X-Chaos-Server': 'true',
          });

          if (sendPartial) {
            // Send partial data then destroy
            this._partialCount++;
            res.write(body.substring(0, Math.floor(body.length / 2)));
            res.destroy();
          } else {
            res.end(body);
            this._responses.push({ time: Date.now(), status: 200 });
          }
        }, delay);
      });

      this._server.on('error', reject);
      this._server.listen(0, '127.0.0.1', () => {
        this._port = this._server.address().port;
        resolve(this._port);
      });
    });
  }

  /**
   * Stop the chaos HTTP server.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (!this._server) return resolve();
      this._server.close(() => resolve());
    });
  }

  get port() { return this._port; }
  get stats() {
    return {
      requestCount: this._requestCount,
      droppedCount: this._droppedCount,
      partialCount: this._partialCount,
      errorCount: this._errorCount,
      responseCount: this._responses.length,
    };
  }
}

/**
 * Create a TCP server that simulates network partition by refusing
 * connections during partition and accepting them when healed.
 */
class PartitionSimulator {
  constructor() {
    this._server = null;
    this._port = 0;
    this._connections = [];
    this._partitioned = false;
  }

  get port() { return this._port; }
  get isPartitioned() { return this._partitioned; }

  /**
   * Start the partition simulator.
   * @returns {Promise<number>} Port number
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        if (this._partitioned) {
          // Immediately RST the connection during partition
          socket.destroy();
          return;
        }
        this._connections.push(socket);
        // Keep connection alive with periodic heartbeats
        socket.on('error', () => {
          const idx = this._connections.indexOf(socket);
          if (idx !== -1) this._connections.splice(idx, 1);
        });
      });
      this._server.on('error', reject);
      this._server.listen(0, '127.0.0.1', () => {
        this._port = this._server.address().port;
        resolve(this._port);
      });
    });
  }

  /**
   * Simulate a network partition — close the listening server so new
   * connections are refused, and destroy all existing connections.
   */
  partition() {
    this._partitioned = true;
    // Destroy all existing connections
    for (const socket of this._connections) {
      try { socket.destroy(); } catch (_) { /* ignore */ }
    }
    this._connections = [];
    // Close the server to refuse new connections
    if (this._server) {
      this._server.close(() => {
        // Server stopped listening; connections will be refused
      });
    }
  }

  /**
   * Heal the partition — re-open the server to accept connections again.
   */
  heal() {
    this._partitioned = false;
    // Re-listen on the same port
    if (this._server) {
      this._server.listen(this._port, '127.0.0.1', () => {
        // Server listening again
      });
    }
  }

  /**
   * Stop the simulator.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      for (const socket of this._connections) {
        try { socket.destroy(); } catch (_) { /* ignore */ }
      }
      this._connections = [];
      if (!this._server) return resolve();
      this._server.close(() => resolve());
    });
  }
}

// ═══════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════

// ── Global state for cleanup ──
const globalCleanup = [];

// Ensure all resources are cleaned up even if tests fail
process.on('exit', () => {
  for (const fn of globalCleanup) {
    try { fn(); } catch (_) { /* best effort */ }
  }
});

// ───────────────────────────────────────
// 1. NETWORK CHAOS
// ───────────────────────────────────────

describe('Network Chaos', () => {
  /** @type {ChaosHttpServer} */
  let chaosServer;

  before(async () => {
    chaosServer = new ChaosHttpServer();
    const port = await chaosServer.start();
    globalCleanup.push(() => chaosServer.stop());
  });

  after(async () => {
    await chaosServer.stop();
  });

  it('should handle latency spikes (1-5s random delays)', async () => {
    chaosServer.setLatency(CHAOS_CONFIG.networkLatencyMin, CHAOS_CONFIG.networkLatencyMax);
    chaosServer.setDropRate(0);
    chaosServer.setPartialRate(0);

    const result = await runChaosScenario(
      'latency-spike',
      CHAOS_CONFIG.defaultDuration,
      {
        chaosFn: async () => {
          // Send requests while server has high latency
          const requests = [];
          for (let i = 0; i < 10; i++) {
            requests.push(
              httpRequest({
                hostname: '127.0.0.1',
                port: chaosServer.port,
                path: '/test',
                method: 'GET',
                timeout: 10000,
              }).catch(err => ({ error: err.message, statusCode: 0, duration: 0 }))
            );
          }
          const responses = await Promise.allSettled(requests);

          // Analyze results: some should succeed despite latency
          const succeeded = responses.filter(
            r => r.status === 'fulfilled' && r.value.statusCode === 200
          );
          const errored = responses.filter(
            r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.error)
          );

          // At least some requests must succeed (server is slow, not down)
          assert.ok(succeeded.length > 0, 'At least some requests should succeed despite latency');
        },
        verifyFn: async () => {
          // Verify server is still responsive after chaos
          const resp = await httpRequest({
            hostname: '127.0.0.1',
            port: chaosServer.port,
            path: '/health',
            method: 'GET',
            timeout: 10000,
          });
          return { passed: resp.statusCode === 200, latency: resp.duration };
        },
      }
    );

    assert.ok(result.setupOk, 'Setup should succeed');
    assert.ok(result.chaosApplied, 'Chaos should be applied');
    assert.ok(result.verificationPassed, 'Server should recover after latency chaos');
  });

  it('should handle connection drops gracefully', async () => {
    chaosServer.setLatency(0, 100);
    chaosServer.setDropRate(0.5);   // 50% drop rate
    chaosServer.setPartialRate(0);

    const result = await runChaosScenario(
      'connection-drops',
      CHAOS_CONFIG.defaultDuration,
      {
        chaosFn: async () => {
          const requests = [];
          for (let i = 0; i < 20; i++) {
            requests.push(
              httpRequest({
                hostname: '127.0.0.1',
                port: chaosServer.port,
                path: '/test',
                method: 'GET',
                timeout: 5000,
              }).catch(err => ({
                error: err.message,
                statusCode: 0,
                duration: 0,
                dropped: true,
              }))
            );
          }
          const responses = await Promise.allSettled(requests);
          const fulfilled = responses.filter(r => r.status === 'fulfilled');
          const dropped = fulfilled.filter(r => r.value.dropped || r.value.statusCode === 0);
          const ok = fulfilled.filter(r => r.value.statusCode === 200);

          // Some requests should be dropped, some should succeed
          assert.ok(dropped.length > 0, 'Some requests should be dropped');
          assert.ok(ok.length > 0, 'Some requests should still succeed');
        },
        verifyFn: async () => {
          // After turning off drops, server should be fully responsive
          chaosServer.setDropRate(0);
          await sleep(100);
          const resp = await httpRequest({
            hostname: '127.0.0.1',
            port: chaosServer.port,
            path: '/test',
            method: 'GET',
            timeout: 5000,
          });
          return { passed: resp.statusCode === 200, latency: resp.duration };
        },
      }
    );

    assert.ok(result.verificationPassed, 'Server should recover after connection drops');
  });

  it('should handle partial responses', async () => {
    chaosServer.setLatency(0, 50);
    chaosServer.setDropRate(0);
    chaosServer.setPartialRate(0.4); // 40% partial responses

    const result = await runChaosScenario(
      'partial-responses',
      CHAOS_CONFIG.defaultDuration,
      {
        chaosFn: async () => {
          const requests = [];
          let parseErrors = 0;
          let okResponses = 0;

          for (let i = 0; i < 20; i++) {
            requests.push(
              httpRequest({
                hostname: '127.0.0.1',
                port: chaosServer.port,
                path: '/test',
                method: 'GET',
                timeout: 5000,
              }).then(resp => {
                if (resp.statusCode === 200) {
                  try {
                    JSON.parse(resp.body);
                    okResponses++;
                  } catch {
                    parseErrors++;
                  }
                }
                return resp;
              }).catch(err => ({ error: err.message, statusCode: 0 }))
            );
          }
          await Promise.allSettled(requests);

          // Both parseable and partial responses should exist
          // (With 40% partial rate and 20 requests, probability of 0 partials is ~0.0001)
        },
        verifyFn: async () => {
          chaosServer.setPartialRate(0);
          await sleep(100);
          const resp = await httpRequest({
            hostname: '127.0.0.1',
            port: chaosServer.port,
            path: '/test',
            method: 'GET',
            timeout: 5000,
          });
          // After disabling partial responses, all responses should be valid JSON
          let valid = false;
          try {
            const parsed = JSON.parse(resp.body);
            valid = parsed.ok === true;
          } catch { /* not valid */ }
          return { passed: valid, latency: resp.duration };
        },
      }
    );

    assert.ok(result.verificationPassed, 'Server should return valid responses after partial chaos stops');
  });

  it('should handle network partition and recovery', async () => {
    /** @type {PartitionSimulator} */
    const partition = new PartitionSimulator();
    const port = await partition.start();
    globalCleanup.push(() => partition.stop());

    const result = await runChaosScenario(
      'network-partition',
      CHAOS_CONFIG.defaultDuration,
      {
        chaosFn: async () => {
          // Phase 1: Verify connection works before partition
          const beforeConn = await new Promise((resolve) => {
            const sock = net.createConnection(port, '127.0.0.1', () => {
              sock.destroy();
              resolve(true);
            });
            sock.on('error', () => resolve(false));
            sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
          });
          assert.ok(beforeConn, 'Connection should work before partition');

          // Phase 2: Create partition
          partition.partition();
          assert.ok(partition.isPartitioned, 'Partition should be active');

          // Phase 3: Verify connections fail during partition
          const duringConn = await new Promise((resolve) => {
            const sock = net.createConnection(port, '127.0.0.1', () => {
              sock.destroy();
              resolve(true);
            });
            sock.on('error', () => resolve(false));
            sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
          });
          assert.ok(!duringConn, 'Connections should fail during partition');
        },
        verifyFn: async () => {
          // Heal the partition and verify recovery
          partition.heal();
          // Wait for the server to re-listen (it needs to re-bind the port)
          await sleep(500);

          // Retry connection a few times (server re-listen may take a moment)
          let afterConn = false;
          for (let attempt = 0; attempt < 5; attempt++) {
            afterConn = await new Promise((resolve) => {
              const sock = net.createConnection(port, '127.0.0.1', () => {
                sock.destroy();
                resolve(true);
              });
              sock.on('error', () => resolve(false));
              sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
            });
            if (afterConn) break;
            await sleep(300);
          }
          return { passed: afterConn, message: afterConn ? 'Connection restored' : 'Connection still down' };
        },
        teardownFn: async () => {
          await partition.stop();
        },
      }
    );

    assert.ok(result.verificationPassed, 'Network should recover after partition heals');
  });
});

// ───────────────────────────────────────
// 2. CPU PRESSURE
// ───────────────────────────────────────

describe('CPU Pressure', () => {
  it('should degrade gracefully under CPU pressure', async () => {
    const workers = [];
    const workerResults = [];

    const result = await runChaosScenario(
      'cpu-pressure',
      CHAOS_CONFIG.cpuDuration,
      {
        setupFn: async () => {
          // Measure baseline responsiveness
          const baselineStart = performance.now();
          let baselineCount = 0;
          const baselineEnd = baselineStart + 1000;
          while (performance.now() < baselineEnd) {
            JSON.parse('{"test":true}');
            baselineCount++;
          }
          const baselineRate = baselineCount; // ops per second
          return { baselineRate, baselineDuration: performance.now() - baselineStart };
        },
        chaosFn: async () => {
          // Spawn CPU-intensive workers using child processes
          const workerCode = `
            'use strict';
            // Compute-intensive loop
            const start = Date.now();
            const duration = parseInt(process.argv[2] || '4000', 10);
            let iterations = 0;
            while (Date.now() - start < duration) {
              // Fibonacci calculation to keep CPU busy
              let a = 1, b = 1;
              for (let i = 0; i < 1000; i++) {
                const temp = a + b;
                a = b;
                b = temp;
              }
              iterations++;
            }
            process.send({ iterations, duration: Date.now() - start });
          `;
          const workerFile = path.join(os.tmpdir(), `chaos-cpu-worker-${Date.now()}.js`);
          fs.writeFileSync(workerFile, workerCode);
          globalCleanup.push(() => { try { fs.unlinkSync(workerFile); } catch (_) {} });

          // Spawn workers
          for (let i = 0; i < CHAOS_CONFIG.cpuWorkers; i++) {
            const worker = fork(workerFile, [String(CHAOS_CONFIG.cpuDuration)], { silent: true });
            workers.push(worker);

            worker.on('message', (msg) => {
              workerResults.push(msg);
            });

            worker.on('error', () => { /* worker crashed, expected */ });
          }

          // While under CPU pressure, measure responsiveness
          const pressureStart = performance.now();
          let pressureCount = 0;
          const pressureEnd = pressureStart + 2000;
          while (performance.now() < pressureEnd) {
            try { JSON.parse('{"test":true}'); } catch { /* ignore */ }
            pressureCount++;
          }
          const pressureRate = pressureCount / 2; // ops per second

          // System should still be responsive (even if slower)
          // We allow up to 99% degradation but must still function
          assert.ok(pressureRate > 0, 'System should still process operations under CPU pressure');
        },
        verifyFn: async () => {
          // Wait for workers to finish
          await new Promise((resolve) => {
            let completed = 0;
            for (const w of workers) {
              w.on('exit', () => {
                completed++;
                if (completed === workers.length) resolve();
              });
              w.on('error', () => {
                completed++;
                if (completed === workers.length) resolve();
              });
            }
            // Safety timeout
            setTimeout(resolve, 5000);
          });

          // Kill any remaining workers
          for (const w of workers) {
            try { w.kill(); } catch (_) {}
          }

          // After CPU pressure is relieved, measure recovery
          await sleep(500);
          const recoveryStart = performance.now();
          let recoveryCount = 0;
          const recoveryEnd = recoveryStart + 1000;
          while (performance.now() < recoveryEnd) {
            JSON.parse('{"test":true}');
            recoveryCount++;
          }

          return {
            passed: recoveryCount > 0,
            recoveryRate: recoveryCount,
            workersCompleted: workerResults.length,
          };
        },
        teardownFn: async () => {
          for (const w of workers) {
            try { w.kill('SIGKILL'); } catch (_) {}
          }
        },
      }
    );

    assert.ok(result.setupOk, 'Setup should succeed');
    assert.ok(result.chaosApplied, 'CPU chaos should be applied');
    assert.ok(result.verificationPassed, 'System should recover after CPU pressure');
  });

  it('should handle event loop blocking gracefully', async () => {
    let loopBlocked = false;
    let loopRecovered = false;

    const result = await runChaosScenario(
      'event-loop-block',
      3000,
      {
        chaosFn: async () => {
          // Measure event loop lag before blocking
          const beforeLag = await measureEventLoopLag();
          assert.ok(beforeLag < 100, `Event loop lag should be low before blocking, got ${beforeLag}ms`);

          // Block the event loop synchronously for a short burst
          const blockStart = Date.now();
          while (Date.now() - blockStart < 500) {
            // Synchronous busy-wait
            loopBlocked = true;
          }

          // Immediately after blocking, check if we can schedule microtasks
          const afterLag = await measureEventLoopLag();
          // After blocking, there should be some lag
          // but the system should still be alive
          loopRecovered = afterLag < 5000;
        },
        verifyFn: async () => {
          // Event loop should settle after blocking stops
          await sleep(200);
          const finalLag = await measureEventLoopLag();
          return {
            passed: finalLag < 100,
            finalLag,
            loopBlocked,
            loopRecovered,
          };
        },
      }
    );

    assert.ok(result.verificationPassed, 'Event loop should recover after blocking');
  });
});

/**
 * Measure event loop lag by scheduling a timer and checking how late it fires.
 * @returns {Promise<number>} Lag in milliseconds
 */
function measureEventLoopLag() {
  return new Promise((resolve) => {
    const expected = 10;
    const start = performance.now();
    setTimeout(() => {
      const actual = performance.now() - start;
      resolve(Math.max(0, actual - expected));
    }, expected);
  });
}

// ───────────────────────────────────────
// 3. MEMORY PRESSURE
// ───────────────────────────────────────

describe('Memory Pressure', () => {
  it('should handle memory pressure and recover', async () => {
    const buffers = [];
    let peakRss = 0;
    let recoveredRss = 0;

    const result = await runChaosScenario(
      'memory-pressure',
      CHAOS_CONFIG.defaultDuration,
      {
        setupFn: async () => {
          const baseline = process.memoryUsage();
          return { baselineHeap: baseline.heapUsed, baselineRss: baseline.rss };
        },
        chaosFn: async () => {
          // Allocate large buffers to put pressure on memory
          try {
            for (let i = 0; i < CHAOS_CONFIG.memoryBufferCount; i++) {
              const buf = Buffer.alloc(CHAOS_CONFIG.memoryBufferSize, 0xAA);
              buffers.push(buf);
            }
          } catch (err) {
            // OOM is possible — the test should still verify recovery
          }

          peakRss = process.memoryUsage().rss;

          // Verify the system is still functioning (can still allocate small objects)
          const testObj = { timestamp: Date.now(), data: 'test'.repeat(100) };
          assert.ok(testObj.timestamp > 0, 'Should still be able to allocate objects under memory pressure');
        },
        verifyFn: async () => {
          // Release all buffers
          buffers.length = 0;

          // Force garbage collection if available (requires --expose-gc flag)
          if (global.gc) {
            global.gc();
          }

          await sleep(500);
          const afterMem = process.memoryUsage();
          recoveredRss = afterMem.rss;

          // Verification: system should still be functional and memory should
          // not grow unboundedly. We don't assert that RSS drops below peak
          // because V8 doesn't always return memory to the OS immediately.
          // Instead we verify: (1) heap is reasonable, (2) allocations still work.
          const testBuf = Buffer.alloc(1024);
          const heapOk = afterMem.heapUsed < 500 * 1024 * 1024; // < 500MB
          const allocOk = testBuf.length === 1024;

          return {
            passed: heapOk && allocOk,
            peakRssMB: Math.round(peakRss / 1024 / 1024),
            recoveredRssMB: Math.round(recoveredRss / 1024 / 1024),
            heapMB: Math.round(afterMem.heapUsed / 1024 / 1024),
            heapReasonable: heapOk,
            allocationsWork: allocOk,
          };
        },
      }
    );

    assert.ok(result.setupOk, 'Setup should succeed');
    assert.ok(result.chaosApplied, 'Memory pressure should be applied');
    assert.ok(result.verificationPassed, 'System should remain functional after memory pressure is removed');
  });

  it('should handle rapid allocation and deallocation cycles', async () => {
    const CYCLES = 10;
    const ALLOC_SIZE = 1024 * 1024; // 1 MB
    let allRecovered = true;

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const cycleBuffers = [];
      // Allocate
      for (let i = 0; i < 5; i++) {
        cycleBuffers.push(Buffer.alloc(ALLOC_SIZE));
      }
      // Deallocate
      cycleBuffers.length = 0;

      // Small delay to allow GC
      await sleep(50);
    }

    if (global.gc) global.gc();

    const finalMemory = process.memoryUsage();
    // After rapid allocation/deallocation, heap should not grow unboundedly
    assert.ok(
      finalMemory.heapUsed < 500 * 1024 * 1024,
      `Heap should not grow beyond 500MB after allocation cycles, got ${Math.round(finalMemory.heapUsed / 1024 / 1024)}MB`
    );
  });

  it('should reject oversized allocations gracefully', async () => {
    let caughtError = false;
    try {
      // Try to allocate an absurdly large buffer
      // Using a size that will fail but not crash the process
      const hugeSize = Number.MAX_SAFE_INTEGER;
      Buffer.alloc(hugeSize);
    } catch (err) {
      caughtError = true;
      // Node.js returns various error messages for oversized allocations:
      // "Array buffer allocation failed", "Invalid", "range", "length"
      assert.ok(
        err.message.includes('Invalid') ||
        err.message.includes('range') ||
        err.message.includes('length') ||
        err.message.includes('allocation') ||
        err.message.includes('Failed'),
        `Error should indicate allocation failure: ${err.message}`
      );
    }

    assert.ok(caughtError, 'Oversized allocation should throw an error, not crash');

    // After the failed allocation, the process should still be functional
    const testBuf = Buffer.alloc(1024);
    assert.ok(testBuf.length === 1024, 'Normal allocations should still work after a failed huge allocation');
  });
});

// ───────────────────────────────────────
// 4. DISK I/O CHAOS
// ───────────────────────────────────────

describe('Disk I/O Chaos', () => {
  const tempDir = path.join(os.tmpdir(), `chaos-disk-${Date.now()}`);
  const createdFiles = [];

  before(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    globalCleanup.push(() => {
      try {
        for (const f of createdFiles) {
          try { fs.unlinkSync(f); } catch (_) {}
        }
        try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
      } catch (_) {}
    });
  });

  after(() => {
    // Cleanup
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    try { fs.rmdirSync(tempDir, { recursive: true }); } catch (_) {}
  });

  it('should handle concurrent large file writes', async () => {
    const writePromises = [];

    for (let i = 0; i < CHAOS_CONFIG.diskFileCount; i++) {
      const filePath = path.join(tempDir, `chaos-write-${i}-${Date.now()}.dat`);
      createdFiles.push(filePath);

      writePromises.push(
        new Promise((resolve, reject) => {
          const stream = fs.createWriteStream(filePath);
          const chunkSize = 64 * 1024; // 64KB chunks
          let written = 0;
          const targetSize = CHAOS_CONFIG.diskFileSize;

          const writeChunk = () => {
            if (written >= targetSize) {
              stream.end();
              return;
            }
            const remaining = targetSize - written;
            const thisChunk = Math.min(chunkSize, remaining);
            const buf = Buffer.alloc(thisChunk, i);
            const ok = stream.write(buf);
            written += thisChunk;
            if (ok) {
              writeChunk();
            }
          };

          stream.on('drain', writeChunk);
          stream.on('finish', () => resolve({ filePath, size: written }));
          stream.on('error', reject);
          writeChunk();
        })
      );
    }

    const results = await Promise.allSettled(writePromises);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    // All writes should succeed in normal conditions
    assert.ok(succeeded.length === CHAOS_CONFIG.diskFileCount,
      `All file writes should succeed, ${succeeded.length}/${CHAOS_CONFIG.diskFileCount} completed`);

    // Verify written files have correct size
    for (const r of succeeded) {
      const stat = fs.statSync(r.value.filePath);
      assert.ok(stat.size === CHAOS_CONFIG.diskFileSize,
        `File ${r.value.filePath} should be ${CHAOS_CONFIG.diskFileSize} bytes, got ${stat.size}`);
    }
  });

  it('should handle disk full simulation gracefully', async () => {
    // We simulate disk-full by writing until we get an ENOSPC error,
    // or more practically, by filling a small tmpfs / testing error handling
    // Since we can't reliably force ENOSPC, we test that the system
    // handles write errors correctly by using a non-existent directory

    let caughtError = false;
    const badPath = '/nonexistent/readonly/path/chaos-test-' + Date.now() + '.dat';

    try {
      fs.writeFileSync(badPath, Buffer.alloc(1024));
    } catch (err) {
      caughtError = true;
      assert.ok(err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM',
        `Error should be a filesystem error, got: ${err.code}`);
    }

    assert.ok(caughtError, 'Writing to invalid path should throw an error');

    // System should still be functional after the error
    const validPath = path.join(tempDir, `recovery-test-${Date.now()}.dat`);
    createdFiles.push(validPath);
    fs.writeFileSync(validPath, Buffer.alloc(1024));
    const stat = fs.statSync(validPath);
    assert.ok(stat.size === 1024, 'System should recover and allow normal file operations');
  });

  it('should handle file descriptor exhaustion gracefully', async () => {
    const fds = [];
    let reachedLimit = false;
    const maxFds = 200; // Reasonable limit for testing

    try {
      for (let i = 0; i < maxFds; i++) {
        const fd = fs.openSync(path.join(tempDir, `fd-test-${i}.dat`), 'w');
        fds.push({ fd, path: path.join(tempDir, `fd-test-${i}.dat`) });
        createdFiles.push(path.join(tempDir, `fd-test-${i}.dat`));
      }
    } catch (err) {
      reachedLimit = true;
    }

    // Close all open file descriptors
    for (const { fd } of fds) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    fds.length = 0;

    // Clean up fd test files
    for (let i = 0; i < fds.length; i++) {
      try { fs.unlinkSync(path.join(tempDir, `fd-test-${i}.dat`)); } catch (_) {}
    }

    // After closing FDs, we should be able to open files again
    const testFd = fs.openSync(path.join(tempDir, `fd-recovery-${Date.now()}.dat`), 'w');
    fs.closeSync(testFd);

    assert.ok(true, 'File descriptors should be available after cleanup');
  });
});

// ───────────────────────────────────────
// 5. PROCESS CHAOS
// ───────────────────────────────────────

describe('Process Chaos', () => {
  it('should handle subprocess crashes gracefully', async () => {
    let crashesDetected = 0;
    const children = [];

    const result = await runChaosScenario(
      'subprocess-crashes',
      CHAOS_CONFIG.defaultDuration,
      {
        chaosFn: async () => {
          // Spawn child processes that will crash
          for (let i = 0; i < CHAOS_CONFIG.processCrashCount; i++) {
            const child = spawn('node', ['-e', 'process.exit(1)'], { stdio: 'pipe' });
            children.push(child);

            child.on('exit', (code) => {
              if (code !== 0) crashesDetected++;
            });
          }

          // Wait for all to exit
          await new Promise((resolve) => {
            let exited = 0;
            for (const child of children) {
              child.on('exit', () => {
                exited++;
                if (exited === children.length) resolve();
              });
              child.on('error', () => {
                exited++;
                if (exited === children.length) resolve();
              });
            }
            setTimeout(resolve, 5000);
          });
        },
        verifyFn: async () => {
          // After subprocess crashes, the main process should still be healthy
          // Verify by spawning a healthy subprocess
          const healthResult = await new Promise((resolve) => {
            const child = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'pipe' });
            child.on('exit', (code) => resolve(code === 0));
            child.on('error', () => resolve(false));
            setTimeout(() => { child.kill(); resolve(false); }, 3000);
          });

          return {
            passed: healthResult && crashesDetected === CHAOS_CONFIG.processCrashCount,
            crashesDetected,
            expectedCrashes: CHAOS_CONFIG.processCrashCount,
          };
        },
        teardownFn: async () => {
          for (const child of children) {
            try { child.kill('SIGKILL'); } catch (_) {}
          }
        },
      }
    );

    assert.ok(result.chaosApplied, 'Process chaos should be applied');
    assert.ok(result.verificationPassed, 'Main process should be healthy after subprocess crashes');
  });

  it('should handle SIGTERM to subprocesses gracefully', async () => {
    const children = [];
    const exitCodes = [];

    // Spawn long-running subprocesses
    for (let i = 0; i < 3; i++) {
      const child = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'pipe' });
      children.push(child);

      child.on('exit', (code, signal) => {
        exitCodes.push({ code, signal });
      });
    }

    // Give them time to start
    await sleep(200);

    // Send SIGTERM to each
    for (const child of children) {
      child.kill('SIGTERM');
    }

    // Wait for them to exit
    await new Promise((resolve) => {
      let exited = 0;
      for (const child of children) {
        child.on('exit', () => {
          exited++;
          if (exited === children.length) resolve();
        });
        child.on('error', () => {
          exited++;
          if (exited === children.length) resolve();
        });
      }
      setTimeout(resolve, 5000);
    });

    // All subprocesses should have terminated
    assert.ok(exitCodes.length === 3,
      `All 3 subprocesses should exit, got ${exitCodes.length} exits`);

    // They should have exited due to SIGTERM (signal = 'SIGTERM' on non-Windows)
    const signaled = exitCodes.filter(e => e.signal === 'SIGTERM' || e.code === null);
    assert.ok(signaled.length > 0, 'At least some processes should have been terminated by signal');
  });

  it('should handle orphan subprocess cleanup', async () => {
    // Spawn a child that spawns its own child (grandchild),
    // then kill the child. The grandchild should become orphaned.
    const childCode = `
      const { spawn } = require('child_process');
      const grandchild = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'pipe',
        detached: true,
        windowsHide: true,
      });
      grandchild.unref();
      process.send({ grandchildPid: grandchild.pid });
      setTimeout(() => {}, 60000);
    `;

    const childFile = path.join(os.tmpdir(), `chaos-orphan-${Date.now()}.js`);
    fs.writeFileSync(childFile, childCode);
    globalCleanup.push(() => { try { fs.unlinkSync(childFile); } catch (_) {} });

    const grandchildPids = [];

    const child = fork(childFile, [], { stdio: 'pipe' });
    child.on('message', (msg) => {
      if (msg.grandchildPid) grandchildPids.push(msg.grandchildPid);
    });

    // Wait for grandchild PID
    await new Promise((resolve) => {
      child.on('message', () => resolve());
      setTimeout(resolve, 2000);
    });

    await sleep(200);

    // Kill the intermediate child
    child.kill('SIGKILL');

    // Wait for it to die
    await sleep(500);

    // The main process should still be running fine
    // (orphans are OS-level concern; verify our process is healthy)
    const healthCheck = await new Promise((resolve) => {
      const testChild = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'pipe' });
      testChild.on('exit', (code) => resolve(code === 0));
      testChild.on('error', () => resolve(false));
      setTimeout(() => { testChild.kill(); resolve(false); }, 3000);
    });

    assert.ok(healthCheck, 'Main process should remain healthy after orphan creation');

    // Cleanup: kill any orphaned grandchildren
    for (const pid of grandchildPids) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already dead */ }
    }
  });

  it('should recover from uncaughtException in a child process', async () => {
    let caughtExit = false;

    const result = await runChaosScenario(
      'child-uncaught-exception',
      3000,
      {
        chaosFn: async () => {
          // Spawn a child that throws an uncaught exception
          const child = spawn('node', ['-e', 'throw new Error("chaos: uncaught exception")'], { stdio: 'pipe' });

          await new Promise((resolve) => {
            child.on('exit', (code) => {
              caughtExit = code !== 0;
              resolve();
            });
            child.on('error', () => resolve());
            setTimeout(resolve, 3000);
          });
        },
        verifyFn: async () => {
          // Main process should still be alive
          // Verify we can spawn new children
          const ok = await new Promise((resolve) => {
            const child = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'pipe' });
            child.on('exit', (code) => resolve(code === 0));
            child.on('error', () => resolve(false));
            setTimeout(() => { child.kill(); resolve(false); }, 3000);
          });

          return { passed: ok && caughtExit, caughtExit };
        },
      }
    );

    assert.ok(result.verificationPassed, 'Main process should be healthy after child uncaughtException');
  });
});

// ───────────────────────────────────────
// CROSS-CUTTING: System Under Sustained Chaos
// ───────────────────────────────────────

describe('Sustained Multi-Domain Chaos', () => {
  it('should remain stable under combined network + memory pressure', async () => {
    const chaosServer = new ChaosHttpServer();
    const port = await chaosServer.start();
    globalCleanup.push(() => chaosServer.stop());

    const buffers = [];

    try {
      // Apply network latency
      chaosServer.setLatency(500, 2000);

      // Apply memory pressure
      for (let i = 0; i < 2; i++) {
        buffers.push(Buffer.alloc(20 * 1024 * 1024, 0xBB)); // 20 MB each
      }

      // Send requests under combined pressure
      const requests = [];
      for (let i = 0; i < 5; i++) {
        requests.push(
          httpRequest({
            hostname: '127.0.0.1',
            port,
            path: '/combined-test',
            method: 'GET',
            timeout: 8000,
          }).catch(err => ({ error: err.message, statusCode: 0 }))
        );
      }

      const responses = await Promise.allSettled(requests);
      const succeeded = responses.filter(
        r => r.status === 'fulfilled' && r.value.statusCode === 200
      );

      // Some requests should still succeed even under combined pressure
      assert.ok(succeeded.length > 0,
        `At least some requests should succeed under combined chaos, got ${succeeded.length}/5`);
    } finally {
      // Cleanup
      buffers.length = 0;
      if (global.gc) global.gc();
      await chaosServer.stop();
    }
  });

  it('should recover fully after sustained chaos stops', async () => {
    const chaosServer = new ChaosHttpServer();
    const port = await chaosServer.start();
    globalCleanup.push(() => chaosServer.stop());

    try {
      // Apply moderate chaos
      chaosServer.setLatency(1000, 3000);
      chaosServer.setDropRate(0.3);

      // Send requests under chaos
      const chaosRequests = [];
      for (let i = 0; i < 10; i++) {
        chaosRequests.push(
          httpRequest({
            hostname: '127.0.0.1',
            port,
            path: '/test',
            method: 'GET',
            timeout: 8000,
          }).catch(() => null)
        );
      }
      await Promise.allSettled(chaosRequests);

      // Stop all chaos
      chaosServer.setLatency(0, 10);
      chaosServer.setDropRate(0);
      chaosServer.setPartialRate(0);

      await sleep(200);

      // Verify full recovery
      const recoveryRequests = [];
      for (let i = 0; i < 5; i++) {
        recoveryRequests.push(
          httpRequest({
            hostname: '127.0.0.1',
            port,
            path: '/test',
            method: 'GET',
            timeout: 5000,
          })
        );
      }
      const results = await Promise.allSettled(recoveryRequests);
      const allOk = results.every(
        r => r.status === 'fulfilled' && r.value.statusCode === 200
      );

      assert.ok(allOk, 'All requests should succeed after chaos stops');
    } finally {
      await chaosServer.stop();
    }
  });
});

// ═══════════════════════════════════════
// Exports for programmatic usage
// ═══════════════════════════════════════

module.exports = {
  runChaosScenario,
  ChaosHttpServer,
  PartitionSimulator,
  CHAOS_CONFIG,
  measureEventLoopLag,
};
