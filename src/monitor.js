// Position monitoring: shared price polling, exit trigger detection, personality-aware thresholds.

import { log, retry, sleep, agentId } from './utils.js';

const DEXSCREENER_URL = 'https://api.dexscreener.com';
const BATCH_SIZE = 30;

// --- Module State ---

// Map<agentNum, MonitorEntry> — registered positions with resolve/reject callbacks.
const activeMonitors = new Map();

// Map<tokenAddress, { price, liquidity, updatedAt }> — shared across all monitors.
const priceCache = new Map();

let pollTimer = null;
let pollIntervalMs = 2000;

// Rate limiter: budget of 200 req/min for monitoring (separate from scanner).
const rateLimiter = {
  timestamps: [],
  maxPerMinute: 200,

  async wait() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);
    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = 60_000 - (now - oldest) + 100;
      log.debug(`Monitor rate limiter: waiting ${waitMs}ms`);
      await sleep(waitMs);
    }
    this.timestamps.push(Date.now());
  },
};

// --- Internal: Price Polling ---

// Start the shared price polling loop. Called on first monitor registration.
function startPricePolling(intervalMs) {
  if (pollTimer) return;
  pollIntervalMs = intervalMs;
  pollTimer = setInterval(() => pollPrices().catch(err => {
    log.warn(`Price poll error: ${err.message}`);
  }), pollIntervalMs);
  log.info(`Monitor price polling started (${pollIntervalMs}ms interval)`);
}

// Stop the polling loop. Called when no monitors remain.
function stopPricePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log.info('Monitor price polling stopped');
  }
}

// Batch-fetch prices for all actively monitored tokens from the DEX data API.
async function pollPrices() {
  if (activeMonitors.size === 0) return;

  // Collect unique token addresses from all active monitors
  const tokenSet = new Set();
  for (const entry of activeMonitors.values()) {
    tokenSet.add(entry.position.tokenAddress);
  }
  const tokens = [...tokenSet];

  // Batch into groups of 30 per API limit
  const batches = [];
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    batches.push(tokens.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      await rateLimiter.wait();
      const joined = batch.join(',');
      const res = await fetch(`${DEXSCREENER_URL}/tokens/v1/solana/${joined}`);
      if (!res.ok) {
        log.warn(`Price poll HTTP ${res.status} — skipping batch`);
        continue;
      }
      const pairs = await res.json();
      if (!Array.isArray(pairs)) continue;

      const now = Date.now();
      for (const pair of pairs) {
        const addr = pair.baseToken?.address;
        if (!addr) continue;
        const price = parseFloat(pair.priceUsd);
        const liquidity = pair.liquidity?.usd || 0;
        if (price > 0) {
          priceCache.set(addr, { price, liquidity, updatedAt: now });
        }
      }
    } catch (err) {
      log.warn(`Price poll fetch failed: ${err.message} — skipping cycle`);
    }
  }

  evaluateAllPositions();
}

// --- Internal: Exit Evaluation ---

// Check all active monitors against current prices and trigger exits.
function evaluateAllPositions() {
  for (const [agentNum, entry] of activeMonitors) {
    const cached = priceCache.get(entry.position.tokenAddress);
    if (!cached) continue;

    const { price, liquidity } = cached;

    // Track peak price for trailing stop
    if (price > entry.peakPrice) {
      entry.peakPrice = price;
    }

    const trigger = checkExitTriggers(entry, price, liquidity);
    if (trigger) {
      const pnlPercent = ((price - entry.position.entryPrice) / entry.position.entryPrice) * 100;
      const duration = Date.now() - entry.position.timestamp;

      entry.resolve({
        exitReason: trigger,
        currentPrice: price,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
        duration,
        liquidity,
      });
      activeMonitors.delete(agentNum);
    }
  }

  // Stop polling if no monitors remain
  if (activeMonitors.size === 0) {
    stopPricePolling();
  }
}

// Evaluate exit conditions in priority order. Returns trigger name or null.
function checkExitTriggers(entry, price, liquidity) {
  const { position, thresholds, rules, peakPrice } = entry;
  const pnlPercent = ((price - position.entryPrice) / position.entryPrice) * 100;
  const elapsed = Date.now() - position.timestamp;

  // 1. Rug detection: liquidity dropped drastically from entry baseline
  if (entry.entryLiquidity > 0 && thresholds.rugDropPercent > 0) {
    const liqDropPercent = ((entry.entryLiquidity - liquidity) / entry.entryLiquidity) * 100;
    if (liqDropPercent >= thresholds.rugDropPercent) {
      return 'rug_detected';
    }
  }

  // 2. Stop loss: hard floor
  if (pnlPercent <= -thresholds.stopLossPct) {
    return 'stop_loss';
  }

  // 3. Trailing stop: only active after peak crosses take-profit threshold
  if (thresholds.hasTrailingStop && peakPrice > 0) {
    const peakPnl = ((peakPrice - position.entryPrice) / position.entryPrice) * 100;
    if (peakPnl >= thresholds.takeProfitPct) {
      const trailFloor = peakPrice * (1 - thresholds.stopLossPct / 100);
      if (price <= trailFloor) {
        return 'trailing_stop';
      }
    }
  }

  // 4. Take profit: non-trailing agents exit at target
  if (!thresholds.hasTrailingStop && pnlPercent >= thresholds.takeProfitPct) {
    return 'take_profit';
  }

  // 5. Timeout: impatient agents bail early
  if (thresholds.timeoutMs > 0 && elapsed >= thresholds.timeoutMs) {
    return 'timeout';
  }

  // 6. Global max hold: hard ceiling for all strategies
  if (rules?.maxHoldTimeMs && elapsed >= rules.maxHoldTimeMs) {
    return 'max_hold_time';
  }

  return null;
}

// --- Internal: Threshold Mapping ---

// Map personality exit_strategy to numeric thresholds.
function getEffectiveThresholds(rules, personality) {
  const base = {
    takeProfitPct: rules.exitTriggers?.takeProfitPercent || rules.takeProfitPercent || 20,
    stopLossPct: rules.exitTriggers?.stopLossPercent || rules.stopLossPercent || 10,
    rugDropPercent: rules.exitTriggers?.rugDetectionLiquidityDropPercent || 50,
    hasTrailingStop: false,
    timeoutMs: 0,
  };

  const strategy = personality?.exit_strategy || 'strict';

  switch (strategy) {
    case 'strict':
      // Base values unchanged
      break;

    case 'trailing_stop':
      base.hasTrailingStop = true;
      break;

    case 'impatient':
      base.timeoutMs = 30 * 60 * 1000; // 30 minutes
      break;

    case 'diamond_hands':
      base.takeProfitPct = 30;
      base.stopLossPct = 15;
      break;

    case 'partial_exits':
      // Treat as strict in Phase 3 — partial exit logic deferred
      log.debug(`partial_exits strategy treated as strict (Phase 3)`);
      break;

    default:
      log.warn(`Unknown exit_strategy "${strategy}", using strict defaults`);
      break;
  }

  return base;
}

// --- Exports ---

// Monitor an open position until an exit trigger fires. Returns a Promise that resolves
// with the exit result. One shared poll loop serves all active monitors.
export function monitorPosition(agentNum, position, rules, personality) {
  return new Promise((resolve, reject) => {
    const thresholds = getEffectiveThresholds(rules, personality);

    // Capture entry liquidity from price cache if available, or 0
    const cached = priceCache.get(position.tokenAddress);
    const entryLiquidity = cached?.liquidity || 0;

    const entry = {
      position,
      thresholds,
      rules,
      peakPrice: position.entryPrice,
      entryLiquidity,
      resolve,
      reject,
    };

    activeMonitors.set(agentNum, entry);

    // Start polling if this is the first monitor
    const intervalMs = rules.monitorIntervalMs || 2000;
    startPricePolling(intervalMs);

    log.info(
      `Monitoring agent ${agentId(agentNum)}: TP=${thresholds.takeProfitPct}% SL=${thresholds.stopLossPct}%` +
      (thresholds.hasTrailingStop ? ' [trailing]' : '') +
      (thresholds.timeoutMs > 0 ? ` [timeout=${thresholds.timeoutMs / 1000}s]` : '') +
      (rules.maxHoldTimeMs ? ` [maxHold=${rules.maxHoldTimeMs / 3600000}h]` : ''),
      { agent: agentId(agentNum) }
    );
  });
}

// Cancel a specific agent's monitor, resolving with 'cancelled'.
export function cancelMonitor(agentNum) {
  const entry = activeMonitors.get(agentNum);
  if (entry) {
    entry.resolve({
      exitReason: 'cancelled',
      currentPrice: priceCache.get(entry.position.tokenAddress)?.price || 0,
      pnlPercent: 0,
      duration: Date.now() - entry.position.timestamp,
      liquidity: priceCache.get(entry.position.tokenAddress)?.liquidity || 0,
    });
    activeMonitors.delete(agentNum);

    if (activeMonitors.size === 0) stopPricePolling();
  }
}

// Graceful shutdown: resolve all monitors with 'shutdown' and stop polling.
export function stopMonitoring() {
  for (const [agentNum, entry] of activeMonitors) {
    entry.resolve({
      exitReason: 'shutdown',
      currentPrice: priceCache.get(entry.position.tokenAddress)?.price || 0,
      pnlPercent: 0,
      duration: Date.now() - entry.position.timestamp,
      liquidity: priceCache.get(entry.position.tokenAddress)?.liquidity || 0,
    });
  }
  activeMonitors.clear();
  stopPricePolling();
  log.info('All monitors stopped (shutdown)');
}

// Return current monitoring metrics.
export function getMonitorStats() {
  return {
    activePositions: activeMonitors.size,
    uniqueTokens: new Set([...activeMonitors.values()].map(e => e.position.tokenAddress)).size,
    pricesCached: priceCache.size,
  };
}
