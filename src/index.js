// Main orchestrator: agent loop management, startup recovery, graceful shutdown.

import 'dotenv/config';
import { readJson, writeJson, log, sleep, agentId, agentDir } from './utils.js';
import { loadProvider, scan, decide, getUsageStats } from './brain.js';
import { startScanner, stopScanner, getCandidates, markSeen } from './scanner.js';
import { compileSafetyReport } from './safety.js';
import { executeBuy, executeSell, hasOpenPosition, getOpenPosition } from './trader.js';
import { monitorPosition, stopMonitoring } from './monitor.js';
import {
  initTournament, getAgentBalance, getAgentRecord, getShotsRemaining,
  adjustReserve, updateStandings, getStandingsForAgent, checkDeath, checkCircuitBreaker
} from './tournament.js';
import { startDashboard, stopDashboard, recordTrade } from './dashboard.js';

// --- Module State ---

let rules = null;
let personalities = null;
let shuttingDown = false;
let standingsTimer = null;
const agentLoops = new Map();
const skipCounts = new Map();

// --- Skip Count Persistence ---

// Load skip counts from each agent's state.json into memory.
async function loadSkipCounts() {
  for (let i = 1; i <= rules.agentsPerTournament; i++) {
    const state = await readJson(`${agentDir(i)}/state.json`);
    if (state && typeof state.skips === 'number') {
      skipCounts.set(i, state.skips);
    }
  }
  log.info(`Loaded skip counts for ${skipCounts.size} agents`);
}

// Persist an agent's skip count into its state.json file.
async function saveSkipCount(agentNum, count) {
  const statePath = `${agentDir(agentNum)}/state.json`;
  const state = (await readJson(statePath)) || {};
  state.skips = count;
  await writeJson(statePath, state);
}

// --- Decision Log ---

// Append a decision entry to the agent's persistent decision log.
async function appendDecisionLog(agentNum, entry) {
  const logPath = `${agentDir(agentNum)}/decisions.json`;
  const decisions = (await readJson(logPath)) || [];
  decisions.push(entry);
  await writeJson(logPath, decisions);
}

// --- Tournament Checks ---

// Check if the tournament duration has elapsed.
async function isTournamentOver() {
  const snapshot = await readJson('logs/standings.json');
  if (!snapshot) return false;
  return snapshot.day >= rules.durationDays;
}

// --- Resume: Recover Open Position ---

// Resume monitoring for an agent that crashed mid-trade.
async function resumePosition(agentNum, personality) {
  const position = await getOpenPosition(agentNum);
  if (!position) return;

  const ctx = { agent: agentId(agentNum) };
  log.info(`Resuming open position: ${position.tokenSymbol}`, ctx);

  const entry = {
    timestamp: Date.now(),
    type: 'resume',
    token: position.tokenAddress,
    symbol: position.tokenSymbol,
    outcome: null,
  };

  try {
    const exitResult = await monitorPosition(agentNum, position, rules, personality);
    const sellResult = await executeSell(agentNum, position.tokenAddress, exitResult.exitReason);

    if (sellResult.success) {
      recordTrade({
        agentNum,
        symbol: position.tokenSymbol,
        pnl: sellResult.pnl,
        pnlPercent: sellResult.pnlPercent,
        exitReason: exitResult.exitReason,
      });
      log.info(`Resumed position closed: ${sellResult.pnl >= 0 ? '+' : ''}$${sellResult.pnl.toFixed(2)} [${exitResult.exitReason}]`, ctx);

      entry.outcome = {
        buySuccess: true,
        exitReason: exitResult.exitReason,
        pnl: sellResult.pnl,
        pnlPercent: sellResult.pnlPercent,
        duration: sellResult.duration || null,
      };
    }

    const death = await checkDeath(agentNum, rules);
    if (death.dead) {
      const cb = await checkCircuitBreaker(rules);
      if (cb.triggered) shuttingDown = true;
    }
  } catch (err) {
    log.error(`Resume position failed: ${err.message}`, ctx);
  }

  await appendDecisionLog(agentNum, entry);
}

// --- Trade Cycle ---

// Run one scan-evaluate-trade cycle for an agent.
async function runOneCycle(agentNum, personality) {
  const ctx = { agent: agentId(agentNum) };

  // Decision log entry — built progressively, appended at the end
  const entry = {
    timestamp: Date.now(),
    candidates: 0,
    scan: null,
    safety: null,
    decision: null,
    context: null,
    outcome: null,
  };

  // 1. Get candidates from scanner cache
  const candidates = getCandidates(agentNum);
  entry.candidates = candidates.length;
  if (candidates.length === 0) {
    await appendDecisionLog(agentNum, entry);
    return;
  }

  // 2. LLM scan: lightweight evaluation
  const scanResult = await scan(agentId(agentNum), personality, candidates);

  // Mark ALL candidates as seen regardless of scan result
  for (const c of candidates) {
    markSeen(agentNum, c.address);
  }

  entry.scan = {
    action: scanResult.action,
    token: scanResult.token || null,
    symbol: null,
    reasoning: scanResult.reasoning || '',
  };

  if (scanResult.action === 'skip') {
    log.debug(`Scan: skip (${scanResult.reasoning?.slice(0, 60) || 'no reason'})`, ctx);
    await appendDecisionLog(agentNum, entry);
    return;
  }

  // 3. Safety check on selected token
  const token = candidates.find(c => c.address === scanResult.token);
  if (!token) {
    log.warn(`Scan selected unknown token ${scanResult.token}`, ctx);
    await appendDecisionLog(agentNum, entry);
    return;
  }

  entry.scan.symbol = token.symbol;

  const safetyReport = await compileSafetyReport(token.address, token.liquidity, rules);

  entry.safety = {
    pass: safetyReport.pass,
    riskLevel: safetyReport.riskLevel || null,
    report: safetyReport.report || '',
  };

  if (!safetyReport.pass) {
    log.info(`Safety hard-blocked ${token.symbol}: honeypot`, ctx);
    await appendDecisionLog(agentNum, entry);
    return;
  }

  // 4. Assemble full context for trade decision
  const balance = await getAgentBalance(agentNum, rules);
  const record = await getAgentRecord(agentNum);
  record.skips = skipCounts.get(agentNum) || 0;
  const shotsRemaining = await getShotsRemaining(agentNum, rules);
  const standings = await getStandingsForAgent(agentNum, rules);
  const daysRemaining = Math.max(0, rules.durationDays - standings.day);

  const candidateStr = `${token.symbol} (${token.address}): price $${token.price}, liquidity $${token.liquidity}, volume $${token.volume}, age ${token.age}`;

  const decideContext = {
    balance,
    record,
    shotsRemaining,
    daysRemaining,
    standings,
    candidate: candidateStr,
    safetyReport: safetyReport.report,
    rules,
  };

  // 5. LLM decide: full trade decision
  const decision = await decide(agentId(agentNum), personality, decideContext);

  entry.decision = {
    action: decision.action,
    reasoning: decision.reasoning || '',
    thinking: decision.thinking || null,
    investAmount: decision.invest_amount || null,
    reserveAdjustment: decision.reserve_adjustment || null,
  };

  entry.context = {
    balance: { investable: balance.investable, reserve: balance.reserve, total: balance.total },
    rank: standings.rank,
    day: standings.day,
    shotsRemaining,
    record: { wins: record.wins, losses: record.losses, skips: record.skips },
  };

  // 6. Execute decision
  if (decision.action === 'skip') {
    const count = (skipCounts.get(agentNum) || 0) + 1;
    skipCounts.set(agentNum, count);
    await saveSkipCount(agentNum, count);
    log.debug(`Decision: skip #${count} (${decision.reasoning?.slice(0, 60) || ''})`, ctx);
    await appendDecisionLog(agentNum, entry);
    return;
  }

  if (decision.action === 'adjust_reserve') {
    const result = await adjustReserve(agentNum, decision.reserve_adjustment, rules);
    log.info(`Reserve adjust: ${result.success ? 'ok' : result.reason}`, ctx);
    await appendDecisionLog(agentNum, entry);
    return;
  }

  // action === 'trade'
  if (balance.investable < rules.minTradeUsdc) {
    log.warn(`Investable $${balance.investable.toFixed(2)} below minimum $${rules.minTradeUsdc}`, ctx);
    await appendDecisionLog(agentNum, entry);
    return;
  }

  const investAmount = Math.min(decision.invest_amount, balance.investable);
  log.info(`Trading: $${investAmount.toFixed(2)} → ${token.symbol}`, ctx);

  const buyResult = await executeBuy(agentNum, token.address, investAmount, rules);
  if (!buyResult.success) {
    log.warn(`Buy failed: ${buyResult.reason || 'unknown'}`, ctx);
    entry.outcome = { buySuccess: false, exitReason: null, pnl: null, pnlPercent: null, duration: null };
    await appendDecisionLog(agentNum, entry);
    return;
  }

  // Monitor position until exit trigger fires
  const position = await getOpenPosition(agentNum);
  const exitResult = await monitorPosition(agentNum, position, rules, personality);

  // Sell on exit trigger
  const sellResult = await executeSell(agentNum, token.address, exitResult.exitReason);

  if (sellResult.success) {
    recordTrade({
      agentNum,
      symbol: token.symbol,
      pnl: sellResult.pnl,
      pnlPercent: sellResult.pnlPercent,
      exitReason: exitResult.exitReason,
    });

    entry.outcome = {
      buySuccess: true,
      exitReason: exitResult.exitReason,
      pnl: sellResult.pnl,
      pnlPercent: sellResult.pnlPercent,
      duration: sellResult.duration || null,
    };
  } else {
    entry.outcome = { buySuccess: true, exitReason: exitResult.exitReason, pnl: null, pnlPercent: null, duration: null };
  }

  await appendDecisionLog(agentNum, entry);

  // Check death and circuit breaker after each trade
  const death = await checkDeath(agentNum, rules);
  if (death.dead) {
    const cb = await checkCircuitBreaker(rules);
    if (cb.triggered) shuttingDown = true;
  }
}

// --- Agent Loop ---

// Run a single agent's trading loop: staggered start, crash isolation, inter-cycle delay.
async function runAgentLoop(agentNum) {
  const ctx = { agent: agentId(agentNum) };
  const personality = personalities[agentNum - 1];
  if (!personality) {
    log.error(`No personality for agent ${agentNum}`, ctx);
    return;
  }

  // Check if agent is already dead or eliminated
  const state = await readJson(`${agentDir(agentNum)}/state.json`);
  if (state && (!state.alive || state.eliminated)) {
    log.debug(`Agent already ${state.eliminated ? 'eliminated' : 'dead'}, skipping`, ctx);
    return;
  }

  // Staggered start: random delay spread across the scan interval
  const maxDelayMs = (rules.scanIntervalMinutes || 5) * 60_000;
  const startDelay = Math.floor(Math.random() * maxDelayMs);
  log.debug(`Staggered start: ${(startDelay / 1000).toFixed(0)}s delay`, ctx);
  await sleep(startDelay);

  // Resume any open position from a previous crash
  if (hasOpenPosition(agentNum)) {
    await resumePosition(agentNum, personality);
  }

  // Main loop
  while (!shuttingDown) {
    // Re-check alive/eliminated status each iteration
    const currentState = await readJson(`${agentDir(agentNum)}/state.json`);
    if (currentState && (!currentState.alive || currentState.eliminated)) {
      log.info(`Agent now ${currentState.eliminated ? 'eliminated' : 'dead'}, exiting loop`, ctx);
      break;
    }

    // Check tournament duration
    if (await isTournamentOver()) {
      log.info('Tournament duration reached, exiting loop', ctx);
      break;
    }

    // Check shots remaining
    const shots = await getShotsRemaining(agentNum, rules);
    if (shots <= 0) {
      log.debug('No shots remaining, waiting', ctx);
      await sleep(5 * 60_000);
      continue;
    }

    // Run one trade cycle with crash isolation
    try {
      await runOneCycle(agentNum, personality);
    } catch (err) {
      log.error(`Cycle error: ${err.message}`, ctx);
      await sleep(60_000); // 60s cooldown on error
    }

    // Inter-cycle delay: random 30s to 3min
    if (!shuttingDown) {
      const delay = 30_000 + Math.floor(Math.random() * 150_000);
      await sleep(delay);
    }
  }
}

// --- Startup ---

// Initialize all systems and launch agent loops.
async function startup() {
  log.info('Darwin starting up...');

  // Load configuration
  rules = await readJson('config/tournament-rules.json');
  personalities = await readJson('config/personalities.json');

  if (!rules) throw new Error('Missing config/tournament-rules.json');
  if (!personalities || !Array.isArray(personalities)) throw new Error('Missing config/personalities.json');

  log.info(`Config loaded: ${rules.agentsPerTournament} agents, ${rules.durationDays} days, $${rules.startingCapitalUsdc} starting capital`);

  // Initialize LLM provider
  await loadProvider();

  // Initialize tournament state (idempotent)
  await initTournament(rules);

  // Check circuit breaker before launching
  const cb = await checkCircuitBreaker(rules);
  if (cb.triggered) {
    log.error('Circuit breaker already triggered. Aborting startup.');
    process.exit(1);
  }

  // Start token scanner
  startScanner(rules);

  // Load skip counts from disk
  await loadSkipCounts();

  // Start dashboard
  startDashboard({ refreshIntervalMs: 30_000, rules });

  // Launch all agent loops
  const agentCount = rules.agentsPerTournament;
  log.info(`Launching ${agentCount} agent loops...`);

  for (let i = 1; i <= agentCount; i++) {
    const promise = runAgentLoop(i).catch(err => {
      log.error(`Agent loop fatal: ${err.message}`, { agent: agentId(i) });
    });
    agentLoops.set(i, promise);
  }

  // Refresh standings every 30 minutes
  standingsTimer = setInterval(() => {
    updateStandings(rules).catch(err => {
      log.warn(`Standings refresh failed: ${err.message}`);
    });
  }, 30 * 60_000);

  // Wait for all agent loops to complete
  await Promise.allSettled([...agentLoops.values()]);
  log.info('All agent loops finished');

  // Clean shutdown after natural completion
  await shutdown();
}

// --- Shutdown ---

// Graceful shutdown: stop all subsystems, wait for loops, persist final state.
async function shutdown() {
  if (shuttingDown && !standingsTimer) return; // Already shut down
  shuttingDown = true;
  log.info('Shutting down...');

  // Stop subsystems
  stopScanner();
  stopMonitoring();

  if (standingsTimer) {
    clearInterval(standingsTimer);
    standingsTimer = null;
  }

  stopDashboard();

  // Wait for agent loops with a 30s timeout
  const loopPromises = [...agentLoops.values()];
  if (loopPromises.length > 0) {
    const timeout = sleep(30_000).then(() => 'timeout');
    const result = await Promise.race([
      Promise.allSettled(loopPromises),
      timeout,
    ]);
    if (result === 'timeout') {
      log.warn('Agent loops did not finish within 30s timeout');
    }
  }

  // Final standings update
  try {
    await updateStandings(rules);
  } catch (err) {
    log.warn(`Final standings update failed: ${err.message}`);
  }

  // Log usage summary
  const usage = getUsageStats();
  log.info(`Session summary — Scans: ${usage.scan.calls}, Decisions: ${usage.decide.calls}, ` +
    `Input tokens: ${usage.scan.inputTokens + usage.decide.inputTokens}, ` +
    `Output tokens: ${usage.scan.outputTokens + usage.decide.outputTokens}`);

  process.exit(0);
}

// --- Entry Point ---

async function main() {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await startup();
  } catch (err) {
    log.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
}

main();
