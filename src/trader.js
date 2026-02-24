// DEX swap execution: quote, buy, sell, paper trading mock, trade history persistence.

import { createJupiterApiClient } from '@jup-ag/api';
import { Connection, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token';
import { log, retry, readJson, writeJson, agentDir, agentId } from './utils.js';
import { loadKeypair } from './wallets.js';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import 'dotenv/config';

// --- Module State ---

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAPER_MODE = process.env.PAPER_TRADING === 'true';

const jupiterApi = createJupiterApiClient();
const decimalsCache = new Map();

function getConnection() {
  return new Connection(RPC_URL, 'confirmed');
}

// --- Internal: Quoting ---

// Fetch a swap quote from the DEX aggregator with retry logic.
async function getQuote(inputMint, outputMint, amountRaw, slippageBps) {
  return retry(
    async () => {
      const quote = await jupiterApi.quoteGet({
        inputMint,
        outputMint,
        amount: amountRaw,
        slippageBps,
        swapMode: 'ExactIn',
      });
      if (!quote || !quote.outAmount) {
        throw new Error('Quote response missing outAmount');
      }
      return quote;
    },
    { attempts: 3, baseDelay: 1500, label: 'DEX quote' }
  );
}

// --- Internal: Swap Execution ---

// Sign, send, and confirm a swap transaction on-chain. Never called in paper mode.
async function executeSwap(agentKeypair, quoteResponse, maxRetries) {
  const conn = getConnection();

  return retry(
    async () => {
      const swapResult = await jupiterApi.swapPost({
        swapRequest: {
          userPublicKey: agentKeypair.publicKey.toBase58(),
          quoteResponse,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
        },
      });

      const txBuf = Buffer.from(swapResult.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([agentKeypair]);

      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });

      await conn.confirmTransaction(
        { signature: sig, lastValidBlockHeight: swapResult.lastValidBlockHeight, blockhash: tx.message.recentBlockhash },
        'confirmed'
      );

      return sig;
    },
    { attempts: maxRetries, baseDelay: 2000, label: 'DEX swap' }
  );
}

// --- Internal: Token Queries ---

// Look up on-chain token balance for a wallet. Returns 0 if no account exists.
async function getTokenBalance(publicKey, mintAddress) {
  const conn = getConnection();
  const decimals = await getTokenDecimals(mintAddress);
  const mint = new PublicKey(mintAddress);
  const ata = await getAssociatedTokenAddress(mint, publicKey);

  try {
    const account = await getAccount(conn, ata);
    const raw = Number(account.amount);
    return { raw, human: raw / Math.pow(10, decimals), decimals };
  } catch (err) {
    if (err.name === 'TokenAccountNotFoundError') {
      return { raw: 0, human: 0, decimals };
    }
    throw err;
  }
}

// Fetch token decimals from on-chain mint data, with in-memory caching.
async function getTokenDecimals(mintAddress) {
  if (decimalsCache.has(mintAddress)) return decimalsCache.get(mintAddress);

  const conn = getConnection();
  const mintInfo = await getMint(conn, new PublicKey(mintAddress));
  decimalsCache.set(mintAddress, mintInfo.decimals);
  return mintInfo.decimals;
}

// --- Internal: Trade History ---

// Append a trade entry to the agent's persistent history file.
async function appendTradeHistory(agentNum, trade) {
  const historyPath = `${agentDir(agentNum)}/history.json`;
  const history = (await readJson(historyPath)) || [];
  history.push(trade);
  await writeJson(historyPath, history);
}

// --- Exports: Buy ---

// Execute a token purchase: get quote, enforce caps, swap (or simulate in paper mode).
export async function executeBuy(agentNum, tokenAddress, usdcAmount, rules) {
  const ctx = { agent: agentId(agentNum) };
  const walletPath = `${agentDir(agentNum)}/wallet.json`;
  const keypair = await loadKeypair(walletPath);
  if (!keypair) throw new Error(`Wallet not found for agent ${agentId(agentNum)}`);

  // Cap enforcement
  const cappedAmount = Math.min(usdcAmount, rules.maxTradeCapUsdc);
  if (cappedAmount < usdcAmount) {
    log.warn(`Investment clamped from $${usdcAmount} to $${cappedAmount} (max cap)`, ctx);
  }

  const slippageBps = rules.slippageBps || 300;
  const amountRaw = Math.round(cappedAmount * 1e6);

  log.info(`Quoting buy: $${cappedAmount} USDC → ${tokenAddress.slice(0, 8)}…`, ctx);

  const quote = await getQuote(USDC_MINT, tokenAddress, amountRaw, slippageBps);

  // Price impact gate
  const priceImpactPct = parseFloat(quote.priceImpactPct) || 0;
  if (priceImpactPct > (rules.poolImpactMaxPercent || 2)) {
    log.warn(`Price impact ${priceImpactPct}% exceeds limit ${rules.poolImpactMaxPercent}%`, ctx);
    return { success: false, reason: 'price_impact_too_high', priceImpactPct };
  }

  let signature;
  let outputAmount;
  const tokenDecimals = await getTokenDecimals(tokenAddress);

  if (PAPER_MODE) {
    signature = `paper-${Date.now()}`;
    outputAmount = Number(quote.outAmount);
    log.info(`Paper buy: ${outputAmount / Math.pow(10, tokenDecimals)} tokens (sig: ${signature})`, ctx);
  } else {
    signature = await executeSwap(keypair, quote, 3);
    const balance = await getTokenBalance(keypair.publicKey, tokenAddress);
    outputAmount = balance.raw;
    log.info(`Live buy confirmed: ${balance.human} tokens (sig: ${signature.slice(0, 16)}…)`, ctx);
  }

  const entryPrice = cappedAmount / (outputAmount / Math.pow(10, tokenDecimals));

  // Save position file (presence = open position)
  const position = {
    tokenAddress,
    tokenSymbol: tokenAddress.slice(0, 6),
    tokenDecimals,
    entryPrice,
    entryAmount: cappedAmount,
    tokenAmount: outputAmount / Math.pow(10, tokenDecimals),
    tokenAmountRaw: outputAmount,
    signature,
    priceImpactPct,
    slippageBps,
    paper: PAPER_MODE,
    timestamp: Date.now(),
  };

  const positionPath = `${agentDir(agentNum)}/position.json`;
  await writeJson(positionPath, position);

  // Append to trade history (entry only, exit fields filled on sell)
  const historyEntry = {
    id: `${agentId(agentNum)}-${Date.now()}`,
    tokenAddress,
    tokenSymbol: position.tokenSymbol,
    entryPrice,
    entryAmount: cappedAmount,
    tokenAmount: position.tokenAmount,
    exitPrice: null,
    exitAmount: null,
    pnl: null,
    pnlPercent: null,
    exitReason: null,
    signature,
    exitSignature: null,
    paper: PAPER_MODE,
    timestamp: position.timestamp,
    exitTimestamp: null,
    duration: null,
  };
  await appendTradeHistory(agentNum, historyEntry);

  return {
    success: true,
    signature,
    inputAmount: cappedAmount,
    outputAmount: position.tokenAmount,
    price: entryPrice,
    priceImpactPct,
    paper: PAPER_MODE,
  };
}

// --- Exports: Sell ---

// Exit a position: get quote, swap (or simulate), calculate P&L, clean up state.
export async function executeSell(agentNum, tokenAddress, exitReason) {
  const ctx = { agent: agentId(agentNum) };
  const walletPath = `${agentDir(agentNum)}/wallet.json`;
  const keypair = await loadKeypair(walletPath);
  if (!keypair) throw new Error(`Wallet not found for agent ${agentId(agentNum)}`);

  const positionPath = `${agentDir(agentNum)}/position.json`;
  const position = await readJson(positionPath);
  if (!position) throw new Error(`No open position for agent ${agentId(agentNum)}`);

  const slippageBps = position.slippageBps || 300;
  let tokenAmountRaw;

  if (PAPER_MODE) {
    tokenAmountRaw = position.tokenAmountRaw;
  } else {
    const balance = await getTokenBalance(keypair.publicKey, tokenAddress);
    tokenAmountRaw = balance.raw;

    // Token already sold (balance is 0) — clean up state only
    if (tokenAmountRaw === 0) {
      log.warn(`On-chain balance is 0 — position already closed, cleaning up state`, ctx);
      await removePosition(positionPath);
      return {
        success: true,
        signature: null,
        inputAmount: 0,
        outputAmount: 0,
        pnl: -position.entryAmount,
        pnlPercent: -100,
        exitReason: 'already_sold',
        paper: false,
      };
    }
  }

  log.info(`Quoting sell: ${tokenAmountRaw} raw → USDC (reason: ${exitReason})`, ctx);

  const quote = await getQuote(tokenAddress, USDC_MINT, tokenAmountRaw, slippageBps);

  let signature;
  let usdcReceived;

  if (PAPER_MODE) {
    signature = `paper-sell-${Date.now()}`;
    usdcReceived = Number(quote.outAmount) / 1e6;
    log.info(`Paper sell: $${usdcReceived.toFixed(2)} USDC (sig: ${signature})`, ctx);
  } else {
    signature = await executeSwap(keypair, quote, 5);
    usdcReceived = Number(quote.outAmount) / 1e6;
    log.info(`Live sell confirmed: $${usdcReceived.toFixed(2)} USDC (sig: ${signature.slice(0, 16)}…)`, ctx);
  }

  const pnl = usdcReceived - position.entryAmount;
  const pnlPercent = (pnl / position.entryAmount) * 100;

  // Update the last history entry with exit data
  const historyPath = `${agentDir(agentNum)}/history.json`;
  const history = (await readJson(historyPath)) || [];
  const lastEntry = history.findLast(h => h.tokenAddress === tokenAddress && !h.exitTimestamp);
  if (lastEntry) {
    lastEntry.exitPrice = usdcReceived / position.tokenAmount;
    lastEntry.exitAmount = usdcReceived;
    lastEntry.pnl = Math.round(pnl * 1e6) / 1e6;
    lastEntry.pnlPercent = Math.round(pnlPercent * 100) / 100;
    lastEntry.exitReason = exitReason;
    lastEntry.exitSignature = signature;
    lastEntry.exitTimestamp = Date.now();
    lastEntry.duration = Date.now() - lastEntry.timestamp;
    await writeJson(historyPath, history);
  }

  // Delete position file (closed position)
  await removePosition(positionPath);

  log.info(`Position closed: PnL $${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%) [${exitReason}]`, ctx);

  return {
    success: true,
    signature,
    inputAmount: position.tokenAmount,
    outputAmount: usdcReceived,
    pnl: Math.round(pnl * 1e6) / 1e6,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    exitReason,
    paper: PAPER_MODE,
  };
}

// Remove a position file, tolerating it already being gone.
async function removePosition(positionPath) {
  try {
    await unlink(positionPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// --- Exports: Position Queries ---

// Check whether an agent has an open position (position.json exists).
export function hasOpenPosition(agentNum) {
  return existsSync(`${agentDir(agentNum)}/position.json`);
}

// Load the current open position for an agent, or null if none.
export async function getOpenPosition(agentNum) {
  return readJson(`${agentDir(agentNum)}/position.json`);
}

// Load the full trade history for an agent, or an empty array.
export async function loadTradeHistory(agentNum) {
  return (await readJson(`${agentDir(agentNum)}/history.json`)) || [];
}
