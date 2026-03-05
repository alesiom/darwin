// Terminal dashboard: live standings, recent trades, system status display.

import chalk from 'chalk';
import { getStandings } from './tournament.js';
import { getMonitorStats } from './monitor.js';
import { getScannerStats } from './scanner.js';
import { getUsageStats } from './brain.js';
import { agentId } from './utils.js';

// --- Module State ---

let refreshTimer = null;
const recentTrades = [];
const MAX_RECENT_TRADES = 10;
const PAPER_MODE = process.env.PAPER_TRADING === 'true';

// --- Exports ---

// Begin periodic dashboard rendering to stdout.
export function startDashboard({ refreshIntervalMs = 30_000, rules } = {}) {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => render(rules), refreshIntervalMs);
  render(rules);
}

// Stop the dashboard render loop.
export function stopDashboard() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// Record a completed trade for the recent trades display.
export function recordTrade(trade) {
  recentTrades.push({ ...trade, time: Date.now() });
  if (recentTrades.length > MAX_RECENT_TRADES) {
    recentTrades.shift();
  }
}

// --- Rendering ---

// Assemble and print the full dashboard block.
async function render(rules) {
  try {
    const snapshot = await getStandings();
    if (!snapshot) return;

    const lines = [];
    lines.push('');
    lines.push(chalk.yellow('═'.repeat(60)));
    lines.push(renderHeader(snapshot, rules));
    lines.push(chalk.yellow('═'.repeat(60)));
    lines.push(renderStandings(snapshot));
    lines.push('');
    lines.push(renderRecentTrades());
    lines.push('');
    lines.push(renderSystemStats());
    lines.push(chalk.yellow('═'.repeat(60)));

    console.log(lines.join('\n'));
  } catch {
    // Dashboard errors should never crash the system
  }
}

// Header line: tournament day, alive/dead counts, paper mode indicator.
function renderHeader(snapshot, rules) {
  const dayStr = `Day ${snapshot.day} of ${rules?.durationDays || 31}`;
  const paperTag = PAPER_MODE ? chalk.magenta(' [PAPER MODE]') : '';
  const monitorStats = getMonitorStats();

  const title = chalk.bold.yellow(`  DARWIN TOURNAMENT — ${dayStr}${paperTag}`);
  const counts = `  Alive: ${chalk.green(snapshot.alive)}/${rules?.agentsPerTournament || 100}` +
    ` | Dead: ${chalk.red(snapshot.dead)}` +
    ` | Monitoring: ${chalk.cyan(monitorStats.activePositions)} positions`;

  return `${title}\n${counts}`;
}

// Top 10 standings and agents near the elimination cutoff.
function renderStandings(snapshot) {
  const alive = snapshot.standings.filter(s => s.alive);
  const top10 = alive.slice(0, 10);
  const eliminationCount = 50;
  const cutoffStart = Math.max(0, alive.length - eliminationCount - 3);
  const cutoffEnd = Math.min(alive.length, alive.length - eliminationCount + 4);
  const nearCutoff = alive.slice(cutoffStart, cutoffEnd)
    .filter(s => !top10.some(t => t.agentNum === s.agentNum));

  const leftLines = [chalk.bold('TOP 10')];
  for (const s of top10) {
    const num = agentId(s.agentNum);
    const bal = `$${s.balance.toFixed(2)}`;
    const record = `${s.wins}W/${s.losses}L`;
    leftLines.push(` ${chalk.gray(`#${String(s.rank).padStart(2)}`)}  ${chalk.cyan(num)}  ${bal.padStart(7)}  ${record}`);
  }

  const rightLines = [chalk.bold('NEAR CUTOFF')];
  for (const s of nearCutoff) {
    const num = agentId(s.agentNum);
    const bal = `$${s.balance.toFixed(2)}`;
    const record = `${s.wins}W/${s.losses}L`;
    rightLines.push(` ${chalk.gray(`#${String(s.rank).padStart(2)}`)}  ${chalk.cyan(num)}  ${bal.padStart(7)}  ${record}`);
  }

  // Side by side: pad left column to 38 chars
  const maxRows = Math.max(leftLines.length, rightLines.length);
  const combined = [];
  for (let i = 0; i < maxRows; i++) {
    const left = (leftLines[i] || '').padEnd(42);
    const right = rightLines[i] || '';
    combined.push(`${left}${right}`);
  }

  return combined.join('\n');
}

// Last 5 trades with PnL coloring.
function renderRecentTrades() {
  const header = chalk.bold('RECENT TRADES');
  const trades = recentTrades.slice(-5).reverse();

  if (trades.length === 0) {
    return `${header}\n ${chalk.gray('No trades yet')}`;
  }

  const lines = [header];
  for (const t of trades) {
    const num = chalk.cyan(agentId(t.agentNum));
    const sym = (t.symbol || '???').padEnd(6);
    const pnlStr = formatPnl(t.pnl, t.pnlPercent);
    const reason = chalk.gray(t.exitReason || '');
    const ago = formatTimeAgo(Date.now() - t.time);
    lines.push(` ${num}  ${sym}  ${pnlStr}  ${reason}  ${chalk.gray(ago)}`);
  }

  return lines.join('\n');
}

// Scanner cache, active monitors, LLM call counts, estimated cost.
function renderSystemStats() {
  const scanner = getScannerStats();
  const monitor = getMonitorStats();
  const llm = getUsageStats();

  const scanCalls = llm.scan.calls;
  const decideCalls = llm.decide.calls;

  // Rough cost estimate (Haiku for both scan and decide)
  const scanCost = (llm.scan.inputTokens * 1 + llm.scan.outputTokens * 5 +
    llm.scan.cacheRead * 0.1 + llm.scan.cacheCreation * 1.25) / 1_000_000;
  const decideCost = (llm.decide.inputTokens * 1 + llm.decide.outputTokens * 5 +
    llm.decide.cacheRead * 0.1 + llm.decide.cacheCreation * 1.25) / 1_000_000;
  const totalCost = scanCost + decideCost;

  return `${chalk.bold('SYSTEM')}: Scanner ${chalk.cyan(scanner.cacheSize)} cached` +
    ` | LLM ${chalk.cyan(scanCalls)} scans / ${chalk.cyan(decideCalls)} decisions` +
    ` | ~$${totalCost.toFixed(2)}`;
}

// --- Helpers ---

// Format PnL with green (profit) or red (loss) coloring.
function formatPnl(pnl, pnlPercent) {
  if (pnl == null) return chalk.gray('pending');
  const sign = pnl >= 0 ? '+' : '';
  const str = `${sign}$${pnl.toFixed(2)} (${sign}${pnlPercent.toFixed(1)}%)`;
  return pnl >= 0 ? chalk.green(str) : chalk.red(str);
}

// Format a duration in milliseconds to a human-readable "Xm ago" string.
function formatTimeAgo(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}
