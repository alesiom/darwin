// Rug-pull detection: external safety scores, on-chain mint/holder checks, report compilation.

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { log, retry } from './utils.js';
import 'dotenv/config';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const RUGCHECK_URL = 'https://api.rugcheck.xyz/v1';

function getConnection() {
  return new Connection(RPC_URL, 'confirmed');
}

// --- Safety Score Cache ---

const rugCheckCache = new Map();
const RUGCHECK_CACHE_TTL = 15 * 60_000; // 15 minutes

// --- External Safety Score ---

// Query an external safety scoring service for a token's risk profile.
export async function queryRugCheck(tokenAddress) {
  const empty = { available: false, score: 0, scoreNormalised: 0, risks: [], rugged: false };

  try {
    // Check cache first
    const cached = rugCheckCache.get(tokenAddress);
    if (cached && Date.now() - cached.time < RUGCHECK_CACHE_TTL) {
      return cached.data;
    }

    const res = await retry(
      async () => {
        const r = await fetch(`${RUGCHECK_URL}/tokens/${tokenAddress}/report/summary`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      },
      { attempts: 2, baseDelay: 1000, label: 'safety score query' }
    );

    const result = {
      available: true,
      score: res.score ?? 0,
      scoreNormalised: res.score_normalised ?? 0,
      risks: Array.isArray(res.risks) ? res.risks : [],
      rugged: res.rugged ?? false,
      totalMarketLiquidity: res.totalMarketLiquidity ?? 0,
      totalLPProviders: res.totalLPProviders ?? 0
    };

    rugCheckCache.set(tokenAddress, { data: result, time: Date.now() });
    return result;
  } catch (err) {
    log.warn(`Safety score query failed for ${tokenAddress}: ${err.message}`);
    return empty;
  }
}

// --- On-Chain Checks ---

// Check whether a token's mint and freeze authorities are revoked.
export async function checkMintAuthority(tokenAddress) {
  const unknown = { mintAuthority: 'unknown', freezeAuthority: 'unknown', supply: '0', decimals: 0 };

  try {
    const conn = getConnection();
    const mintPubkey = new PublicKey(tokenAddress);
    const mintInfo = await retry(
      () => getMint(conn, mintPubkey),
      { attempts: 2, baseDelay: 1000, label: 'mint authority check' }
    );

    return {
      mintAuthority: mintInfo.mintAuthority ? 'active' : 'revoked',
      freezeAuthority: mintInfo.freezeAuthority ? 'active' : 'none',
      supply: mintInfo.supply.toString(),
      decimals: mintInfo.decimals
    };
  } catch (err) {
    log.warn(`Mint authority check failed for ${tokenAddress}: ${err.message}`);
    return unknown;
  }
}

// Analyse top holder concentration using the largest token accounts.
export async function analyzeHolderConcentration(tokenAddress) {
  const unknown = { topHolderPct: 0, top5HolderPct: 0, top10HolderPct: 0, holders: [], available: false };

  try {
    const conn = getConnection();
    const mintPubkey = new PublicKey(tokenAddress);

    const result = await retry(
      () => conn.getTokenLargestAccounts(mintPubkey),
      { attempts: 2, baseDelay: 1000, label: 'holder concentration check' }
    );

    const accounts = result.value || [];
    if (accounts.length === 0) return unknown;

    // Sum all returned amounts to estimate circulating supply among top holders
    const totalVisible = accounts.reduce((sum, a) => sum + Number(a.amount), 0);
    if (totalVisible === 0) return unknown;

    // Calculate concentration percentages from the visible supply
    // Note: this is relative to total supply, which we get from getMint
    // But since we may not have it yet, use the sum of top 20 as a proxy
    // The caller (compileSafetyReport) passes mint data separately
    const holders = accounts.map(a => ({
      address: a.address.toBase58(),
      amount: Number(a.amount),
      pct: 0 // filled in below with total supply
    }));

    return {
      topHolderPct: 0, // placeholder — resolved with supply in compileSafetyReport
      top5HolderPct: 0,
      top10HolderPct: 0,
      holders,
      available: true,
      _rawAccounts: accounts
    };
  } catch (err) {
    log.warn(`Holder concentration check failed for ${tokenAddress}: ${err.message}`);
    return unknown;
  }
}

// Resolve holder percentages once total supply is known.
function resolveHolderPcts(holderData, totalSupply) {
  if (!holderData.available || !totalSupply || totalSupply === 0n) return holderData;

  const supply = Number(totalSupply);
  for (const h of holderData.holders) {
    h.pct = (h.amount / supply) * 100;
  }

  const sorted = holderData.holders.sort((a, b) => b.pct - a.pct);
  holderData.topHolderPct = sorted[0]?.pct || 0;
  holderData.top5HolderPct = sorted.slice(0, 5).reduce((s, h) => s + h.pct, 0);
  holderData.top10HolderPct = sorted.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  delete holderData._rawAccounts;

  return holderData;
}

// --- Pool Liquidity Gate ---

// Check if a trade would have acceptable market impact on the pool. Pure math, no API calls.
export function checkPoolLiquidity(poolLiquidityUsd, rules) {
  const maxCap = rules.maxTradeCapUsdc || 25;
  const maxImpactPct = rules.poolImpactMaxPercent || 2;

  const impactPct = (maxCap / poolLiquidityUsd) * 100;
  const pass = impactPct <= maxImpactPct;

  return { pass, impactPct: Math.round(impactPct * 100) / 100, threshold: maxImpactPct };
}

// --- Report Compilation ---

// Run all safety checks and produce a unified report for the decision engine.
export async function compileSafetyReport(tokenAddress, poolLiquidityUsd, rules) {
  // Gate 1: pool liquidity (no API, fast)
  const liquidityCheck = checkPoolLiquidity(poolLiquidityUsd, rules);
  if (!liquidityCheck.pass) {
    return {
      pass: false,
      riskLevel: 'HIGH',
      report: formatReport({
        riskLevel: 'HIGH',
        liquidityCheck,
        poolLiquidityUsd,
        reason: `Trade impact ${liquidityCheck.impactPct}% exceeds ${liquidityCheck.threshold}% limit`
      }),
      details: { liquidityCheck }
    };
  }

  // Gate 2: parallel safety checks
  const [rugResult, mintResult, holderResult] = await Promise.allSettled([
    queryRugCheck(tokenAddress),
    checkMintAuthority(tokenAddress),
    analyzeHolderConcentration(tokenAddress)
  ]);

  const rug = rugResult.status === 'fulfilled' ? rugResult.value : { available: false };
  const mint = mintResult.status === 'fulfilled' ? mintResult.value : { mintAuthority: 'unknown', freezeAuthority: 'unknown' };
  const holders = holderResult.status === 'fulfilled' ? holderResult.value : { available: false };

  // Resolve holder percentages with supply from mint check
  if (holders.available && mint.supply && mint.supply !== '0') {
    resolveHolderPcts(holders, BigInt(mint.supply));
  }

  // Classify risk level
  const riskLevel = classifyRisk(rug, mint, holders);

  const details = {
    liquidityCheck,
    rugCheck: rug,
    mintAuthority: mint,
    holderConcentration: holders
  };

  // Only hard-block confirmed honeypots (rugged + freeze authority active).
  // All other risk levels pass through as advisory for the decision engine.
  const hardBlock = rug.rugged && mint.freezeAuthority === 'active';

  return {
    pass: !hardBlock,
    riskLevel,
    report: formatReport({ riskLevel, rug, mint, holders, liquidityCheck, poolLiquidityUsd }),
    details
  };
}

// Classify overall risk from individual check results.
function classifyRisk(rug, mint, holders) {
  // HIGH: any critical red flag
  if (mint.mintAuthority === 'active') return 'HIGH';
  if (holders.available && holders.topHolderPct > 50) return 'HIGH';
  if (rug.available && rug.scoreNormalised < 30) return 'HIGH';
  if (rug.rugged) return 'HIGH';

  // LOW: all indicators positive
  const mintRevoked = mint.mintAuthority === 'revoked';
  const goodScore = !rug.available || rug.scoreNormalised >= 70;
  const lowConcentration = !holders.available || holders.topHolderPct <= 15;
  if (mintRevoked && goodScore && lowConcentration) return 'LOW';

  return 'MODERATE';
}

// Format the safety report as a human-readable string for the decision engine.
function formatReport({ riskLevel, rug, mint, holders, liquidityCheck, poolLiquidityUsd, reason }) {
  const lines = [`SAFETY: ${riskLevel} RISK`];

  if (reason) {
    lines.push(`- Reason: ${reason}`);
  }

  if (rug) {
    const scoreStr = rug.available ? `${rug.scoreNormalised}/100` : 'UNAVAILABLE';
    lines.push(`- Safety score: ${scoreStr}`);
  }

  if (mint) {
    lines.push(`- Mint authority: ${(mint.mintAuthority || 'UNKNOWN').toUpperCase()}`);
    lines.push(`- Freeze authority: ${(mint.freezeAuthority || 'UNKNOWN').toUpperCase()}`);
  }

  if (holders && holders.available) {
    lines.push(`- Top holder: ${holders.topHolderPct.toFixed(1)}% | Top 10: ${holders.top10HolderPct.toFixed(1)}%`);
  }

  if (liquidityCheck && poolLiquidityUsd !== undefined) {
    lines.push(`- Pool liquidity: $${poolLiquidityUsd.toLocaleString()} (trade = ${liquidityCheck.impactPct}% of pool)`);
  }

  if (rug && rug.available && rug.risks.length > 0) {
    const riskNames = rug.risks.map(r => r.name || r.description || r).slice(0, 5);
    lines.push(`- Risk flags: ${riskNames.join(', ')}`);
  } else if (rug && rug.available) {
    lines.push('- Risk flags: None');
  }

  return lines.join('\n');
}
