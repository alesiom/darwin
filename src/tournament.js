// Tournament state: shot tracking, standings, death detection, elimination, circuit breaker.

import { log, readJson, writeJson, agentDir, agentId } from './utils.js';
import { loadKeypair, getUsdcBalance, sweepAgent } from './wallets.js';
import { loadTradeHistory, hasOpenPosition, getOpenPosition } from './trader.js';

const PAPER_MODE = process.env.PAPER_TRADING === 'true';

const DEFAULT_STATE = { reserve: 0, alive: true, eliminated: false, deathTimestamp: null, eliminatedTimestamp: null };
const STANDINGS_PATH = 'logs/standings.json';

// --- Internal: Per-Agent State ---

// Read an agent's tournament state from disk. Returns defaults if missing.
async function loadAgentState(agentNum) {
  const state = await readJson(`${agentDir(agentNum)}/state.json`);
  return state || { ...DEFAULT_STATE };
}

// Persist an agent's tournament state to disk.
async function saveAgentState(agentNum, state) {
  await writeJson(`${agentDir(agentNum)}/state.json`, state);
}

// --- Internal: Balance Computation ---

// Derive balance from trade history: starting capital + realized PnL - open position entry.
async function computePaperBalance(agentNum, rules) {
  const history = await loadTradeHistory(agentNum);
  let balance = rules.startingCapitalUsdc;

  for (const trade of history) {
    if (trade.exitTimestamp && trade.pnl !== null) {
      balance += trade.pnl;
    }
  }

  // If there's an open position, that entry amount is locked in the trade
  if (hasOpenPosition(agentNum)) {
    const pos = await getOpenPosition(agentNum);
    if (pos) balance -= pos.entryAmount;
  }

  return balance;
}

// Query on-chain USDC balance for an agent's wallet.
async function computeLiveBalance(agentNum) {
  const walletPath = `${agentDir(agentNum)}/wallet.json`;
  const keypair = await loadKeypair(walletPath);
  if (!keypair) return 0;

  const { usdc } = await getUsdcBalance(keypair.publicKey);
  return usdc;
}

// --- Internal: Standings Formatting ---

// Build a text table for brain.js prompt injection.
function formatStandingsTable(standings) {
  const header = 'Rank | Agent | Balance | W/L | Shots';
  const separator = '-----|-------|---------|-----|------';
  const rows = standings.map(s => {
    const status = s.alive ? '' : ' [DEAD]';
    const rank = s.alive ? String(s.rank).padStart(4) : '   -';
    return `${rank} | ${agentId(s.agentNum)}${status} | $${s.balance.toFixed(2).padStart(7)} | ${s.wins}/${s.losses} | ${s.shotsUsed}`;
  });
  return [header, separator, ...rows].join('\n');
}

// --- Exports: Shot Tracking & Balance (#16) ---

// Get an agent's current balance split into investable and reserve portions.
export async function getAgentBalance(agentNum, rules) {
  const state = await loadAgentState(agentNum);
  let rawBalance;

  try {
    rawBalance = PAPER_MODE
      ? await computePaperBalance(agentNum, rules)
      : await computeLiveBalance(agentNum);
  } catch (err) {
    log.warn(`Balance query failed for agent ${agentId(agentNum)}, using cached: ${err.message}`, { agent: agentId(agentNum) });
    const cached = await readJson(STANDINGS_PATH);
    const entry = cached?.standings?.find(s => s.agentNum === agentNum);
    rawBalance = entry?.balance ?? rules.startingCapitalUsdc;
  }

  const investable = Math.max(0, rawBalance - state.reserve);
  return { investable, reserve: state.reserve, total: rawBalance };
}

// Compute win/loss record from completed trades in history.
export async function getAgentRecord(agentNum) {
  const history = await loadTradeHistory(agentNum);
  const completed = history.filter(t => t.exitTimestamp);

  let wins = 0;
  let losses = 0;
  let bestWin = 0;
  let worstLoss = 0;

  for (const trade of completed) {
    if (trade.pnl > 0) {
      wins++;
      if (trade.pnlPercent > bestWin) bestWin = trade.pnlPercent;
    } else {
      losses++;
      if (trade.pnlPercent < worstLoss) worstLoss = trade.pnlPercent;
    }
  }

  return { wins, losses, bestWin, worstLoss, tradesTotal: completed.length };
}

// Count remaining shots for the current month.
export async function getShotsRemaining(agentNum, rules) {
  const history = await loadTradeHistory(agentNum);
  return rules.shotsPerMonth - history.length;
}

// Adjust an agent's reserve allocation. Positive adds, negative withdraws.
export async function adjustReserve(agentNum, amount, rules) {
  const state = await loadAgentState(agentNum);
  const { total } = await getAgentBalance(agentNum, rules);

  const currentInvestable = Math.max(0, total - state.reserve);

  if (amount > 0 && currentInvestable < amount) {
    return { success: false, reason: 'insufficient_investable', newReserve: state.reserve, newInvestable: currentInvestable };
  }
  if (amount < 0 && state.reserve < Math.abs(amount)) {
    return { success: false, reason: 'insufficient_reserve', newReserve: state.reserve, newInvestable: currentInvestable };
  }

  state.reserve += amount;
  await saveAgentState(agentNum, state);

  const newInvestable = Math.max(0, total - state.reserve);
  log.info(`Reserve adjusted by ${amount > 0 ? '+' : ''}${amount.toFixed(2)} → reserve=$${state.reserve.toFixed(2)}, investable=$${newInvestable.toFixed(2)}`, { agent: agentId(agentNum) });

  return { success: true, newReserve: state.reserve, newInvestable: newInvestable };
}

// --- Exports: Standings (#17) ---

// Recompute standings from all agents and persist snapshot to disk.
export async function updateStandings(rules) {
  const standings = [];

  for (let i = 1; i <= rules.agentsPerTournament; i++) {
    try {
      const [balance, record, state] = await Promise.all([
        getAgentBalance(i, rules),
        getAgentRecord(i),
        loadAgentState(i),
      ]);
      const history = await loadTradeHistory(i);

      standings.push({
        agentNum: i,
        balance: balance.total,
        investable: balance.investable,
        reserve: balance.reserve,
        rank: 0,
        alive: state.alive && !state.eliminated,
        wins: record.wins,
        losses: record.losses,
        shotsUsed: history.length,
      });
    } catch (err) {
      log.warn(`Failed to compute standing for agent ${agentId(i)}: ${err.message}`, { agent: agentId(i) });
      standings.push({
        agentNum: i, balance: 0, investable: 0, reserve: 0,
        rank: 0, alive: false, wins: 0, losses: 0, shotsUsed: 0,
      });
    }
  }

  // Rank alive agents by balance descending
  const alive = standings.filter(s => s.alive).sort((a, b) => b.balance - a.balance);
  alive.forEach((s, idx) => { s.rank = idx + 1; });

  // Dead/eliminated agents get no rank
  standings.filter(s => !s.alive).forEach(s => { s.rank = 0; });

  // Sort final output: alive by rank, then dead
  standings.sort((a, b) => {
    if (a.alive && !b.alive) return -1;
    if (!a.alive && b.alive) return 1;
    return a.rank - b.rank;
  });

  // Compute tournament day
  const existing = await readJson(STANDINGS_PATH);
  const tournamentStart = existing?.tournamentStart || Date.now();
  const day = Math.max(1, Math.ceil((Date.now() - tournamentStart) / (24 * 60 * 60 * 1000)));

  const snapshot = {
    day,
    tournamentStart,
    standings,
    alive: alive.length,
    dead: rules.agentsPerTournament - alive.length,
    lastUpdated: Date.now(),
  };

  await writeJson(STANDINGS_PATH, snapshot);
  log.info(`Standings updated: day ${day}, ${alive.length} alive, ${snapshot.dead} dead`);
  return snapshot;
}

// Read cached standings from disk without recomputing.
export async function getStandings() {
  const snapshot = await readJson(STANDINGS_PATH);
  if (!snapshot) {
    log.warn('No standings snapshot found');
    return null;
  }
  return snapshot;
}

// Format standings for brain.js prompt consumption.
export async function getStandingsForAgent(agentNum, rules) {
  let snapshot = await readJson(STANDINGS_PATH);
  if (!snapshot) {
    snapshot = await updateStandings(rules);
  }

  const agentEntry = snapshot.standings.find(s => s.agentNum === agentNum);
  const table = formatStandingsTable(snapshot.standings);

  return {
    day: snapshot.day,
    alive: snapshot.alive,
    dead: snapshot.dead,
    table,
    rank: agentEntry?.rank || 0,
  };
}

// --- Exports: Death Detection (#17) ---

// Check if an agent's balance has dropped to the death threshold.
export async function checkDeath(agentNum, rules) {
  const { total } = await getAgentBalance(agentNum, rules);
  const dead = total <= rules.deathThreshold;

  if (dead) {
    const state = await loadAgentState(agentNum);
    if (state.alive) {
      state.alive = false;
      state.deathTimestamp = Date.now();
      await saveAgentState(agentNum, state);
      log.info(`Agent ${agentId(agentNum)} declared dead (balance: $${total.toFixed(2)})`, { agent: agentId(agentNum) });
    }
  }

  return { dead, balance: total };
}

// --- Exports: Circuit Breaker (#19) ---

// Check if too many agents have died too early in the tournament.
export async function checkCircuitBreaker(rules) {
  const snapshot = await readJson(STANDINGS_PATH);
  if (!snapshot) {
    return { triggered: false, deadCount: 0, aliveCount: rules.agentsPerTournament, threshold: rules.massDeathCircuitBreaker.threshold, day: 0 };
  }

  const total = rules.agentsPerTournament;
  const deadCount = snapshot.dead;
  const aliveCount = snapshot.alive;
  const day = snapshot.day;
  const { threshold, beforeDay } = rules.massDeathCircuitBreaker;

  const triggered = (deadCount / total) >= threshold && day < beforeDay;

  if (triggered) {
    log.error(`Circuit breaker triggered: ${deadCount}/${total} dead (${(deadCount / total * 100).toFixed(0)}%) on day ${day} (before day ${beforeDay})`);
  }

  return { triggered, deadCount, aliveCount, threshold, day };
}

// --- Exports: Elimination (#18) ---

// Run end-of-month elimination: bottom N agents are eliminated and swept.
export async function runElimination(rules) {
  const snapshot = await updateStandings(rules);
  const eliminated = [];
  const swept = [];
  const errors = [];

  // Filter alive agents and sort by balance ascending (worst first)
  const aliveAgents = snapshot.standings
    .filter(s => s.alive)
    .sort((a, b) => a.balance - b.balance);

  const toEliminate = aliveAgents.slice(0, rules.eliminationCount);

  const masterKp = await loadKeypair('config/master-wallet.json');

  for (const agent of toEliminate) {
    const ctx = { agent: agentId(agent.agentNum) };
    try {
      // Mark eliminated in state
      const state = await loadAgentState(agent.agentNum);
      state.eliminated = true;
      state.eliminatedTimestamp = Date.now();
      state.alive = false;
      await saveAgentState(agent.agentNum, state);
      eliminated.push(agent.agentNum);

      // Sweep funds back to master
      if (!PAPER_MODE && masterKp) {
        const agentKp = await loadKeypair(`${agentDir(agent.agentNum)}/wallet.json`);
        if (agentKp) {
          await sweepAgent(agentKp, masterKp.publicKey);
          swept.push(agent.agentNum);
          log.info(`Swept funds from eliminated agent`, ctx);
        }
      } else if (PAPER_MODE) {
        swept.push(agent.agentNum);
        log.info(`Paper mode: skipped sweep for eliminated agent`, ctx);
      }

      log.info(`Eliminated (rank ${aliveAgents.indexOf(agent) + 1}, balance: $${agent.balance.toFixed(2)})`, ctx);
    } catch (err) {
      errors.push(`Agent ${agentId(agent.agentNum)}: ${err.message}`);
      log.error(`Elimination failed: ${err.message}`, ctx);
    }
  }

  log.info(`Elimination complete: ${eliminated.length} eliminated, ${swept.length} swept, ${errors.length} errors`);
  return { eliminated, swept, errors };
}

// --- Exports: Tournament Init ---

// Initialize tournament state: standings snapshot and per-agent state files.
export async function initTournament(rules) {
  const existing = await readJson(STANDINGS_PATH);
  if (existing) {
    log.info('Tournament already initialized, skipping');
    return existing;
  }

  // Create default state for all agents
  for (let i = 1; i <= rules.agentsPerTournament; i++) {
    const statePath = `${agentDir(i)}/state.json`;
    const current = await readJson(statePath);
    if (!current) {
      await saveAgentState(i, {
        reserve: rules.initialReserveUsdc || 0,
        alive: true,
        eliminated: false,
        deathTimestamp: null,
        eliminatedTimestamp: null,
      });
    }
  }

  // Create initial standings
  const snapshot = await updateStandings(rules);
  log.info(`Tournament initialized: ${rules.agentsPerTournament} agents, day 1`);
  return snapshot;
}
