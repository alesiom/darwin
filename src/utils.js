// Shared utilities: atomic file I/O, structured logging, retry logic.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import chalk from 'chalk';

// --- Atomic JSON I/O ---

// Read and parse a JSON file. Returns null if the file doesn't exist.
export async function readJson(filePath) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Write JSON atomically: write to a temp file, then rename.
// Prevents corruption from partial writes or crashes.
export async function writeJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await rename(tmp, filePath);
}

// --- Logging ---

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

// Structured logger with level filtering and optional agent context.
export const log = {
  error(msg, ctx = {}) {
    if (currentLevel >= LOG_LEVELS.error) {
      const prefix = ctx.agent ? `[${ctx.agent}]` : '';
      console.error(`${chalk.gray(timestamp())} ${chalk.red('ERR')} ${prefix} ${msg}`);
    }
  },
  warn(msg, ctx = {}) {
    if (currentLevel >= LOG_LEVELS.warn) {
      const prefix = ctx.agent ? `[${ctx.agent}]` : '';
      console.warn(`${chalk.gray(timestamp())} ${chalk.yellow('WRN')} ${prefix} ${msg}`);
    }
  },
  info(msg, ctx = {}) {
    if (currentLevel >= LOG_LEVELS.info) {
      const prefix = ctx.agent ? `[${ctx.agent}]` : '';
      console.log(`${chalk.gray(timestamp())} ${chalk.blue('INF')} ${prefix} ${msg}`);
    }
  },
  debug(msg, ctx = {}) {
    if (currentLevel >= LOG_LEVELS.debug) {
      const prefix = ctx.agent ? `[${ctx.agent}]` : '';
      console.log(`${chalk.gray(timestamp())} ${chalk.gray('DBG')} ${prefix} ${msg}`);
    }
  }
};

// --- Retry ---

// Retry an async function with exponential backoff. For external API calls.
export async function retry(fn, { attempts = 3, baseDelay = 1000, label = 'operation' } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts) throw err;
      const delay = baseDelay * Math.pow(2, i - 1);
      log.warn(`${label} failed (attempt ${i}/${attempts}), retrying in ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
}

// --- Helpers ---

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Format a SOL or USDC amount for display (6 decimal places for USDC, 9 for SOL).
export function formatAmount(lamports, decimals = 6) {
  return (lamports / Math.pow(10, decimals)).toFixed(decimals);
}

// Pad an agent number to 3 digits: 1 → "001", 42 → "042".
export function agentId(num) {
  return String(num).padStart(3, '0');
}

// Build the filesystem path for an agent's directory.
export function agentDir(num) {
  return `agents/agent-${agentId(num)}`;
}
