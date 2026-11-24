import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const FQBN = 'arduino:avr:uno';
const COMPILE_TIMEOUT_MS = 10_000; // 10s hard kill limit per build
const MAX_CACHE_ENTRIES = 500;
const MAX_CONCURRENT_BUILDS = 4;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'https://robosa.io', 'https://www.robosa.io'];

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '32kb' })); // Enforce sketch size limit

// --- 1. Simple Sliding-Window Rate Limiter ---
const rateMap = new Map();

function rateLimiter(req, res, next) {
  const key = req.headers['x-student-id'] || req.ip || 'anonymous';
  const now = Date.now();
  const timestamps = (rateMap.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      success: false,
      error: 'Too many compile requests. Please wait a few seconds before running again.',
    });
  }

  timestamps.push(now);
  rateMap.set(key, timestamps);
  next();
}

// --- 2. Bounded LRU Cache (SHA-256 -> .hex) ---
const hexCache = new Map();

function getCachedHex(hash) {
  if (!hexCache.has(hash)) return null;
  const value = hexCache.get(hash);
  // Refresh LRU order
  hexCache.delete(hash);
  hexCache.set(hash, value);
  return value;
}

function setCachedHex(hash, hex) {
  if (hexCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = hexCache.keys().next().value;
    hexCache.delete(oldestKey);
  }
  hexCache.set(hash, hex);
}

// --- 3. Concurrency Queue & In-Flight Deduplication ---
const inFlightBuilds = new Map();
let activeBuilds = 0;
const waitQueue = [];

function acquireBuildSlot() {
  if (activeBuilds < MAX_CONCURRENT_BUILDS) {
    activeBuilds++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseBuildSlot() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift();
    next();
  } else {
    activeBuilds--;
  }
}

// --- 4. GCC / arduino-cli Error Parser ---
function parseCompilerErrors(stderr, tempDir) {
  const sanitized = stderr.replaceAll(tempDir + path.sep, '').replaceAll(tempDir, '');
  const diagnostics = [];
  const regex = /(?:^|\n).*?sketch\.ino:(\d+):(\d+):\s+(error|fatal error|warning):\s+(.+)/g;

  let match;
  while ((match = regex.exec(sanitized)) !== null) {
    diagnostics.push({
      line: Number.parseInt(match[1], 10),
      column: Number.parseInt(match[2], 10),
      severity: match[3].includes('error') ? 'error' : 'warning',
      message: match[4].trim(),
    });
  }

  return {
    diagnostics,
    rawOutput: sanitized.trim(),
  };
}

// --- 5. Core Compilation Runner ---
async function compileSketch(sketchCode) {
  await acquireBuildSlot();
  const buildId = crypto.randomUUID();
  const tempDir = path.join(os.tmpdir(), `robosa-build-${buildId}`);
  const sketchDir = path.join(tempDir, 'sketch');
  const buildOutDir = path.join(tempDir, 'out');
  const sketchFile = path.join(sketchDir, 'sketch.ino');

  try {
    await fs.mkdir(sketchDir, { recursive: true });
    await fs.mkdir(buildOutDir, { recursive: true });
    await fs.writeFile(sketchFile, sketchCode, 'utf8');

    await execFileAsync(
      'arduino-cli',
      [
        'compile',
        '--fqbn',
        FQBN,
        '--output-dir',
        buildOutDir,
        '--warnings',
        'default',
        sketchDir,
      ],
      {
        timeout: COMPILE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      }
    );

    const hexPath = path.join(buildOutDir, 'sketch.ino.hex');
    const hex = await fs.readFile(hexPath, 'utf8');
    return { success: true, hex };
  } catch (err) {
    if (err.killed || err.signal === 'SIGKILL') {
      return {
        success: false,
        diagnostics: [{ line: 1, column: 1, severity: 'error', message: 'Compilation timed out (10s limit).' }],
        rawOutput: 'Compilation timed out.',
      };
    }

    const stderr = err.stderr || err.message || 'Unknown compilation error';
    const parsed = parseCompilerErrors(stderr, tempDir);
    return {
      success: false,
      diagnostics: parsed.diagnostics,
      rawOutput: parsed.rawOutput,
    };
  } finally {
    releaseBuildSlot();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Endpoints ---
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    fqbn: FQBN,
    cachedSketches: hexCache.size,
    activeBuilds,
    queuedBuilds: waitQueue.length,
  });
});

app.post('/compile', rateLimiter, async (req, res) => {
  const startTime = performance.now();
  const { sketch } = req.body || {};

  if (typeof sketch !== 'string' || sketch.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Missing or empty "sketch" string in request body.',
    });
  }

  const normalized = sketch.replace(/\r\n/g, '\n');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');

  // 1. Check LRU cache
  const cachedHex = getCachedHex(hash);
  if (cachedHex) {
    return res.json({
      success: true,
      hex: cachedHex,
      cached: true,
      durationMs: Math.round(performance.now() - startTime),
    });
  }

  // 2. Deduplicate identical concurrent compiles
  let buildPromise = inFlightBuilds.get(hash);
  if (!buildPromise) {
    buildPromise = compileSketch(normalized).finally(() => {
      inFlightBuilds.delete(hash);
    });
    inFlightBuilds.set(hash, buildPromise);
  }

  const result = await buildPromise;
  const durationMs = Math.round(performance.now() - startTime);

  if (!result.success) {
    return res.status(422).json({
      success: false,
      diagnostics: result.diagnostics,
      rawOutput: result.rawOutput,
      durationMs,
    });
  }

  setCachedHex(hash, result.hex);

  return res.json({
    success: true,
    hex: result.hex,
    cached: false,
    durationMs,
  });
});

app.listen(PORT, () => {
  console.log(`Robosa compile server listening on port ${PORT} (${FQBN})`);
});
