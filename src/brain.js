// Provider-agnostic LLM decision engine: prompt assembly, JSON parsing, token tracking.

import { readJson } from './utils.js';
import { log } from './utils.js';
import 'dotenv/config';

let provider = null;

// --- Provider Loading ---

// Load the configured LLM provider module. Called once at startup.
export async function loadProvider() {
  const name = process.env.LLM_PROVIDER || 'anthropic';
  const mod = await import(`./providers/${name}.js`);
  provider = mod;
  log.info(`LLM provider loaded: ${name}`);
  return provider;
}

function getProvider() {
  if (!provider) throw new Error('LLM provider not loaded. Call loadProvider() first.');
  return provider;
}

// --- Token Usage Tracking ---

const usage = { scan: { calls: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 }, decide: { calls: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 } };

function trackUsage(type, tokenUsage) {
  usage[type].calls++;
  usage[type].inputTokens += tokenUsage.input_tokens || 0;
  usage[type].outputTokens += tokenUsage.output_tokens || 0;
  usage[type].cacheRead += tokenUsage.cache_read_input_tokens || 0;
  usage[type].cacheCreation += tokenUsage.cache_creation_input_tokens || 0;
}

// Get cumulative token usage stats for monitoring and cost estimation.
export function getUsageStats() {
  return structuredClone(usage);
}

// --- Prompt Assembly ---

// Build the scan prompt: lightweight evaluation of token candidates.
function buildScanPrompt(agentId, personality, candidates) {
  const personalityBlock = formatPersonality(personality);
  const tokenTable = formatCandidates(candidates);

  return `You are Agent ${agentId}, a Solana token trader with the following personality:
${personalityBlock}

Here are newly listed tokens on Solana DEXes:
${tokenTable}

Based on your personality, are any of these worth investigating further?
Respond with a JSON object:
{
  "action": "investigate" | "skip",
  "token": "address if investigating",
  "reasoning": "brief explanation"
}`;
}

// Build the trade decision prompt: full context with existential framing.
function buildDecidePrompt(agentId, personality, context) {
  const personalityBlock = formatPersonality(personality);
  const { balance, record, shotsRemaining, daysRemaining, standings, candidate, safetyReport, rules } = context;
  const cap = rules.maxTradeCapUsdc;

  return `You are Agent ${agentId}. Your personality:
${personalityBlock}

YOUR STATUS:
- Balance: $${balance.investable} investable + $${balance.reserve} reserve = $${balance.total} total
- Record this month: ${record.wins}W / ${record.losses}L / ${record.skips} skips
- Shots remaining: ${shotsRemaining} of ${rules.shotsPerMonth}
- Days remaining: ${daysRemaining} of ${rules.durationDays}
- Worst loss this month: ${record.worstLoss}
- Best win this month: ${record.bestWin}

TOURNAMENT STANDINGS (Day ${standings.day} of ${rules.durationDays}):
Alive: ${standings.alive}/${rules.agentsPerTournament} | Dead: ${standings.dead}
${standings.table}
Your rank: ${standings.rank} of ${standings.alive}
Top ${rules.agentsPerTournament - rules.eliminationCount} advance to next month. Bottom ${rules.eliminationCount} are eliminated.

CANDIDATE TOKEN:
${candidate}

SAFETY REPORT:
${safetyReport}

CRITICAL RULES:
- If your total balance reaches $0, you are permanently dead.
- Dead agents are automatically eliminated.
- The top ${rules.agentsPerTournament - rules.eliminationCount} agents after day ${rules.durationDays} continue to month 2.
- The bottom ${rules.eliminationCount} are replaced.
- Maximum investment per trade: $${cap}.
  You cannot invest more than this regardless of your balance.

You must decide:
1. SKIP — do not trade. Save your shot for later.
2. TRADE — specify the token address and EXACTLY how much USDC to invest
   (minimum $${rules.minTradeUsdc}, maximum $${cap}).
3. ADJUST_RESERVE — move USDC between your investable balance and reserve.

Respond with a JSON object:
{
  "action": "skip" | "trade" | "adjust_reserve",
  "token": "address if trading",
  "invest_amount": number_if_trading,
  "reserve_adjustment": number_if_adjusting (positive = add to reserve, negative = withdraw from reserve),
  "reasoning": "your full thought process"
}`;
}

// --- Formatting Helpers ---

function formatPersonality(p) {
  const lines = [
    `Entry timing: ${p.entry_timing}`,
    `Token selection: ${p.token_selection}`,
    `Risk filtering: ${p.risk_filtering}`,
    `Exit strategy: ${p.exit_strategy}`,
    `Position sizing: ${p.position_sizing}`,
    `Self-preservation: ${p.self_preservation}`
  ];
  if (p.competitive_aggression) lines.push(`Competitive aggression: ${p.competitive_aggression}`);
  if (p.freeform_description) lines.push(`\nPersonality: ${p.freeform_description}`);
  return lines.join('\n');
}

function formatCandidates(candidates) {
  if (!candidates || candidates.length === 0) return '(no candidates)';
  return candidates.map(c =>
    `- ${c.symbol} (${c.address}): price $${c.price}, liquidity $${c.liquidity}, volume $${c.volume}, age ${c.age}`
  ).join('\n');
}

// --- Response Parsing ---

// Extract and validate JSON from an LLM response string.
function parseJsonResponse(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON object found in response');
  return JSON.parse(jsonMatch[0]);
}

// Validate a scan response has required fields.
function validateScanResponse(data) {
  if (!['investigate', 'skip'].includes(data.action)) {
    throw new Error(`Invalid scan action: ${data.action}`);
  }
  if (data.action === 'investigate' && !data.token) {
    throw new Error('Scan response missing token address for investigate action');
  }
  return data;
}

// Validate a trade decision response has required fields and respects constraints.
function validateDecideResponse(data, rules) {
  if (!['skip', 'trade', 'adjust_reserve'].includes(data.action)) {
    throw new Error(`Invalid decide action: ${data.action}`);
  }
  if (data.action === 'trade') {
    if (!data.token) throw new Error('Trade response missing token address');
    if (typeof data.invest_amount !== 'number' || data.invest_amount <= 0) {
      throw new Error(`Invalid invest_amount: ${data.invest_amount}`);
    }
    if (data.invest_amount < rules.minTradeUsdc) {
      throw new Error(`invest_amount $${data.invest_amount} below minimum $${rules.minTradeUsdc}`);
    }
    // Clamp to cap (code-level enforcement, log if clamped)
    if (data.invest_amount > rules.maxTradeCapUsdc) {
      log.warn(`Clamping invest_amount from $${data.invest_amount} to $${rules.maxTradeCapUsdc}`);
      data.invest_amount = rules.maxTradeCapUsdc;
    }
  }
  if (data.action === 'adjust_reserve' && typeof data.reserve_adjustment !== 'number') {
    throw new Error(`Invalid reserve_adjustment: ${data.reserve_adjustment}`);
  }
  return data;
}

// --- Public Interface ---

// Evaluate token candidates against an agent's personality (lightweight model).
export async function scan(agentId, personality, candidates) {
  const prompt = buildScanPrompt(agentId, personality, candidates);
  const result = await getProvider().scan(prompt);

  trackUsage('scan', result.usage);

  const parsed = parseJsonResponse(result.text);
  return validateScanResponse(parsed);
}

// Make a full trade decision with deep reasoning (strong model).
export async function decide(agentId, personality, context) {
  const rules = context.rules || await readJson('config/tournament-rules.json');
  context.rules = rules;

  const prompt = buildDecidePrompt(agentId, personality, context);
  const result = await getProvider().decide(prompt);

  trackUsage('decide', result.usage);

  const parsed = parseJsonResponse(result.text);
  return validateDecideResponse(parsed, rules);
}
