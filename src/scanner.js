// Token discovery: poll DEX APIs for new pairs, cache results, deduplicate per agent.

import { log, retry, sleep } from './utils.js';

const BASE_URL = 'https://api.dexscreener.com';

// --- State ---

let pollInterval = null;
let rules = null;
let lastPollTime = null;

// Shared token data: Map<tokenAddress, { data, addedAt }>
const pairCache = new Map();

// Per-agent dedup: Map<agentNum, Set<tokenAddress>>
const seenByAgent = new Map();

// --- Rate Limiting ---

const rateLimiter = {
  timestamps: [],
  maxPerMinute: 55, // stay under the 60/min limit

  async wait() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);
    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = 60_000 - (now - oldest) + 100;
      log.debug(`Rate limiter: waiting ${waitMs}ms`);
      await sleep(waitMs);
    }
    this.timestamps.push(Date.now());
  }
};

// --- HTTP ---

// Fetch JSON from a DEX data API with rate limiting and retries.
async function fetchJson(path) {
  await rateLimiter.wait();
  const url = `${BASE_URL}${path}`;
  const res = await retry(
    async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${path}`);
      return r.json();
    },
    { attempts: 3, baseDelay: 2000, label: `GET ${path}` }
  );
  return res;
}

// --- Polling ---

// Discover recently active Solana tokens and fetch their pair data.
async function pollOnce() {
  try {
    const profiles = await fetchJson('/token-profiles/latest/v1');
    if (!Array.isArray(profiles)) {
      log.warn('Token profiles response is not an array');
      return;
    }

    const solanaAddresses = profiles
      .filter(p => p.chainId === 'solana' && p.tokenAddress)
      .map(p => p.tokenAddress);

    if (solanaAddresses.length === 0) {
      log.debug('No Solana tokens in latest profiles');
      return;
    }

    // Deduplicate and skip already-cached addresses
    const unique = [...new Set(solanaAddresses)]
      .filter(addr => !pairCache.has(addr));

    if (unique.length === 0) {
      log.debug('All discovered tokens already cached');
      lastPollTime = Date.now();
      return;
    }

    // Batch into groups of 30 (API limit per request)
    const batches = [];
    for (let i = 0; i < unique.length; i += 30) {
      batches.push(unique.slice(i, i + 30));
    }

    let added = 0;
    for (const batch of batches) {
      const joined = batch.join(',');
      const pairs = await fetchJson(`/tokens/v1/solana/${joined}`);
      if (!Array.isArray(pairs)) continue;

      for (const pair of pairs) {
        if (passesPreFilter(pair)) {
          const addr = pair.baseToken?.address;
          if (!addr || pairCache.has(addr)) continue;
          pairCache.set(addr, { data: pair, addedAt: Date.now() });
          added++;
        }
      }
    }

    purgeExpired();
    lastPollTime = Date.now();
    log.info(`Poll complete: ${added} new pairs cached (${pairCache.size} total)`);
  } catch (err) {
    log.error(`Poll failed: ${err.message}`);
  }
}

// Filter pairs before caching: liquidity, volume, age, valid price.
function passesPreFilter(pair) {
  const filters = rules?.scannerFilters;
  const liq = pair.liquidity?.usd;
  const vol = pair.volume?.h24;
  const price = parseFloat(pair.priceUsd);
  const createdAt = pair.pairCreatedAt;

  if (!liq || !vol || !price || !createdAt) return false;
  if (liq < (rules?.minPoolLiquidityUsdc || 1250)) return false;
  if (vol < (filters?.minVolume24hUsd || 500)) return false;

  const ageMs = Date.now() - createdAt;
  const minAgeMs = (filters?.minTokenAgeMins || 30) * 60_000;
  const maxAgeMs = (filters?.maxTokenAgeDays || 7) * 24 * 60 * 60_000;
  if (ageMs < minAgeMs || ageMs > maxAgeMs) return false;

  return true;
}

// Format milliseconds into a human-readable age string.
function formatAge(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) return `${hours}h ${remainMins}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

// Evict cache entries older than TTL and enforce max cache size.
function purgeExpired() {
  const ttl = rules?.scannerFilters?.cacheTtlMs || 1_800_000;
  const maxSize = rules?.scannerFilters?.maxCacheSize || 1000;
  const now = Date.now();

  for (const [addr, entry] of pairCache) {
    if (now - entry.addedAt > ttl) {
      pairCache.delete(addr);
    }
  }

  // If still over max, remove oldest entries
  if (pairCache.size > maxSize) {
    const sorted = [...pairCache.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt);
    const toRemove = sorted.slice(0, pairCache.size - maxSize);
    for (const [addr] of toRemove) {
      pairCache.delete(addr);
    }
  }
}

// --- Public Interface ---

// Initialise the scanner and begin periodic polling.
export function startScanner(tournamentRules) {
  rules = tournamentRules;
  const intervalMs = (rules.scanIntervalMinutes || 5) * 60_000;

  log.info(`Scanner starting (interval: ${rules.scanIntervalMinutes || 5}min)`);

  // Poll immediately, then on interval
  pollOnce();
  pollInterval = setInterval(pollOnce, intervalMs);
}

// Stop the polling loop.
export function stopScanner() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  log.info('Scanner stopped');
}

// Get unseen candidates for an agent, formatted for brain.js consumption.
export function getCandidates(agentNum) {
  if (!seenByAgent.has(agentNum)) {
    seenByAgent.set(agentNum, new Set());
  }
  const seen = seenByAgent.get(agentNum);
  const now = Date.now();
  const candidates = [];

  for (const [addr, entry] of pairCache) {
    if (seen.has(addr)) continue;
    const p = entry.data;
    const ageMs = now - (p.pairCreatedAt || entry.addedAt);

    candidates.push({
      symbol: p.baseToken?.symbol || 'UNKNOWN',
      address: addr,
      price: parseFloat(p.priceUsd) || 0,
      liquidity: p.liquidity?.usd || 0,
      volume: p.volume?.h24 || 0,
      age: formatAge(ageMs),
      pairAddress: p.pairAddress || '',
      quoteToken: p.quoteToken?.symbol || ''
    });
  }

  return candidates;
}

// Mark a token as seen by a specific agent so it won't appear again.
export function markSeen(agentNum, tokenAddress) {
  if (!seenByAgent.has(agentNum)) {
    seenByAgent.set(agentNum, new Set());
  }
  seenByAgent.get(agentNum).add(tokenAddress);
}

// Return scanner health metrics for monitoring.
export function getScannerStats() {
  return {
    cacheSize: pairCache.size,
    lastPollTime,
    agentsTracking: seenByAgent.size
  };
}
