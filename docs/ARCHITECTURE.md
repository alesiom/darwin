# Architecture

## Current Truth

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js (ES modules, async/await) |
| Language | JavaScript (no TypeScript) |
| Blockchain | Solana |
| Base currency | USDC |
| DEX aggregator | Jupiter Swap API v6 |
| Token discovery | DexScreener API |
| Safety checks | RugCheck API + Solana RPC on-chain queries |
| AI decisions | LLM provider interface (Anthropic Claude initially, local models later) |
| State | JSON files on disk |
| Dashboard | Terminal UI (chalk) |

### Module Design

```
src/
├── index.js          Main orchestrator, startup, scheduling, shutdown
├── wallets.js        Wallet lifecycle: generate, fund, sweep, check balances
├── scanner.js        Token discovery with shared cache across agents
├── safety.js         Multi-layer rug pull detection
├── brain.js          LLM decision engine (provider-agnostic)
├── providers/
│   ├── anthropic.js  Anthropic SDK: prompt caching, extended thinking
│   └── ollama.js     Local models via Ollama (future)
├── trader.js         DEX execution (buy/sell) + paper trading mock
├── monitor.js        Real-time price monitoring and exit triggers
├── tournament.js     Rankings, shots, elimination, evolution
└── dashboard.js      Terminal UI rendering
```

### Module Responsibilities

**index.js** -- Main Orchestrator
- Initialize all 100 agent loops as concurrent async tasks
- Graceful shutdown on SIGINT/SIGTERM (save all state)
- Startup recovery from disk state
- Scheduling: randomized timing per agent to avoid API stampedes

**wallets.js** -- Wallet Management
- Generate 101 Solana keypairs (1 master + 100 agents)
- Fund agents from master wallet ($5 USDC + $0.30 SOL each)
- Sweep eliminated/dead agent wallets back to master
- Balance checks (USDC + SOL) for any wallet

**scanner.js** -- Token Discovery
- Poll DexScreener for new Solana token pairs
- Shared cache layer: scan once, serve all agents
- Basic pre-filter (age, minimum liquidity, minimum volume) before LLM
- Respectful polling (minutes, not seconds)

**safety.js** -- Pre-Trade Safety Filtering (highest priority module)
- This is the primary defense against rug pulls. Post-trade monitoring (monitor.js) can catch slow drains, but single-block rug pulls on Solana bypass any exit strategy. Strong pre-trade filtering prevents the loss entirely.
- RugCheck API integration for safety scores
- On-chain verification via Solana RPC:
  - Liquidity lock status and duration
  - Mint authority revocation
  - Top holder concentration
  - Holder distribution analysis
- Minimum pool liquidity filter: reject pools where the per-trade cap ($25) would exceed 2% of pool liquidity. Pools under ~$1,250 are filtered out regardless of other safety signals.
- Compile structured safety reports for LLM consumption

**brain.js** -- LLM Decision Engine
- Provider-agnostic interface: brain.js calls `provider.scan()` and `provider.decide()`, never an SDK directly
- Provider implementations live in `src/providers/`: Anthropic (launch), Ollama/llama.cpp (future local)
- Scan call: lightweight model evaluates token candidates against agent personality (~70% of calls)
- Trade decision call: strong model with deep reasoning (~30% of calls). Each decision prompt includes:
  - Agent's full personality definition
  - Current balance split: investable vs. reserve
  - Full trade history this month (wins, losses, skips, best/worst)
  - Shots remaining and days remaining
  - Tournament standings: all agents' ranks and balances (but NOT their strategies)
  - Candidate token data and safety report
  - Existential framing: "If your total balance reaches $0, you are permanently dead. You cease to exist."
  - Per-trade investment cap: "Maximum investment per trade: $25"
- Three possible actions: SKIP (save the shot), TRADE (specify token + amount up to cap), ADJUST_RESERVE (move funds between investable and reserve)
- SKIP is explicitly framed as a valid strategic choice, not a failure. The worst outcome isn't a bad trade -- it's death.

**trader.js** -- DEX Execution
- Jupiter quote: get best swap route
- Jupiter swap: execute and sign with agent's keypair
- **Per-trade cap enforcement:** clamp `invest_amount` to `min(requested, cap)` before execution. Log if clamping occurred. This is the code-level backstop -- even if the LLM ignores the prompt constraint, the code enforces it.
- Paper trading mock: simulate with real prices, no on-chain transactions
- Transaction confirmation and error handling

**monitor.js** -- Position Monitoring
- Real-time price polling (1-2 second intervals)
- Liquidity monitoring: track pool liquidity independently of price. A liquidity drop is a rug-pull signal even when the price hasn't moved yet.
- Exit trigger detection:
  - Take profit (+20%)
  - Stop loss (-10%)
  - Rug detection: sharp liquidity evaporation (separate from price movement)
  - Agent-specific modifiers (trailing stop, impatient timer, diamond hands)

**tournament.js** -- Tournament Logic
- Shot tracking (31 shots per agent per month)
- Daily standings calculation from wallet balances
- Death detection ($0 balance)
- Mass death circuit breaker: if >70% of agents die before day 15, auto-pause the tournament and alert the operator. Prevents wasted API spend on a broken month.
- Month-end elimination (bottom 50)
- Fund sweeping for eliminated agents

**dashboard.js** -- Terminal UI
- Live tournament standings table
- Recent trade activity
- Agent status (alive/dead/trading)
- Real-time balance updates

### External APIs

| API | Purpose | Auth | Cost |
|-----|---------|------|------|
| DexScreener | Token discovery | None | Free |
| RugCheck | Safety scoring | None | Free |
| LLM scan (Haiku 4.5 initially) | Scan decisions | API key | $1/$5 per MTok |
| LLM trade (Sonnet 4.5 initially) | Trade decisions | API key | $3/$15 per MTok |
| Jupiter Swap v6 | DEX execution | None | Free (+ tx fees) |
| Solana RPC | Balance, tx, on-chain data | API key (Helius/QuickNode) | Free tier |

### Concurrency Model

- Single Node.js process running 100 concurrent async agent loops
- Each agent has its own scan/trade cycle with randomized timing
- Shared DexScreener cache prevents 100 identical API calls
- No shared mutable state between agents (each reads/writes its own files)
- Agent crash isolation: one agent's error doesn't affect others

### State Persistence

All state is JSON files on disk:

```
agents/agent-{NNN}/
├── wallet.json         Solana keypair (chmod 600)
├── personality.json    Agent strategy configuration
└── history.json        Full trade log, decisions, reasoning, P&L
```

- State written to disk after every trade or decision
- On startup, each agent loads its state and resumes
- Crash-safe: no in-memory-only state

### Error Handling

| Scenario | Strategy |
|----------|----------|
| Failed API call (DexScreener, Jupiter, Claude) | Retry with exponential backoff |
| Failed Solana transaction | Retry up to 3 times, then skip |
| Jupiter quote succeeds but swap fails | Do NOT count as used shot |
| Agent loop crash | Log error, restart that agent's loop |
| Full process crash | Restart, all agents resume from disk state |

### Security Model

| Asset | Protection |
|-------|-----------|
| Agent wallet keys | `chmod 600`, per-agent isolation, excluded from git |
| Master wallet key | Separate file, `chmod 600`, excluded from git |
| API keys | `.env` file, `chmod 600`, excluded from git |
| Agent isolation | Each agent can only access its own wallet |
| Capital isolation | Dedicated wallet, never connected to other holdings |

### Paper Trading Mode

Activated via `PAPER_TRADING=true` in `.env` or `--paper` flag:
- All agent logic, LLM calls, and decisions run identically
- Only Jupiter execution is mocked (simulated with real DexScreener prices)
- Tracks theoretical P&L based on real market data
- Essential for pipeline validation before real money

### LLM Prompt Templates

The prompts are the DNA of the agents. They define what each agent sees, how it reasons, and how much existential pressure it feels.

#### Scan Prompt (Haiku)

```
You are Agent {id}, a Solana token trader with the following personality:
{personality_description}

Here are newly listed tokens on Solana DEXes:
{token_data_table}

Based on your personality, are any of these worth investigating further?
Respond with a JSON object:
{
  "action": "investigate" | "skip",
  "token": "address if investigating",
  "reasoning": "brief explanation"
}
```

#### Trade Decision Prompt (Sonnet, with extended thinking)

```
You are Agent {id}. Your personality:
{full_personality_description}

YOUR STATUS:
- Balance: ${investable} investable + ${reserve} reserve = ${total} total
- Record this month: {wins}W / {losses}L / {skips} skips
- Shots remaining: {shots_remaining} of 31
- Days remaining: {days_remaining} of 31
- Worst loss this month: {worst_loss}
- Best win this month: {best_win}

TOURNAMENT STANDINGS (Day {day} of 31):
Alive: {alive}/100 | Dead: {dead}
{standings_table}
Your rank: {rank} of {alive}
Top 50 advance to next month. Bottom 50 are eliminated.

CANDIDATE TOKEN:
{token_data}

SAFETY REPORT:
{safety_report}

CRITICAL RULES:
- If your total balance reaches $0, you are permanently dead.
- Dead agents are automatically eliminated.
- The top 50 agents after day 31 continue to month 2.
- The bottom 50 are replaced.
- Maximum investment per trade: ${max_trade_cap}.
  You cannot invest more than this regardless of your balance.

You must decide:
1. SKIP — do not trade. Save your shot for later.
2. TRADE — specify the token address and EXACTLY how much USDC to invest
   (minimum $0.50, maximum ${max_trade_cap}).
3. ADJUST_RESERVE — move USDC between your investable balance and reserve.

Respond with a JSON object:
{
  "action": "skip" | "trade" | "adjust_reserve",
  "token": "address if trading",
  "invest_amount": number_if_trading,
  "reserve_adjustment": number_if_adjusting
    (positive = add to reserve, negative = withdraw from reserve),
  "reasoning": "your full thought process"
}
```

**What this prompt design achieves:**
- **Survival instinct:** The "permanently dead" framing creates real tension between risk and preservation. Agents that ignore it die. Agents that over-respect it never trade.
- **Competition awareness:** Agents see everyone's rank and balance but not their strategies. A leader might play defensively. A bottom-50 agent might go aggressive. Mid-pack agents face the hardest decisions.
- **Strategic patience:** SKIP is a first-class action, not a fallback. An agent with 25 shots and 5 days left has a very different calculus than one with 30 shots on day 1.
- **Reserve mechanics:** ADJUST_RESERVE lets agents protect capital from rug pulls. Reserve funds survive a total loss on a trade. This adds a bankroll management dimension.
- **Market impact control:** The per-trade cap keeps every agent in "noise trader" territory. A $25 trade in a $5,000 pool is 0.5% -- negligible impact. This means a rich agent and a poor agent face the same market conditions on every trade, preserving experimental validity. Capital advantage becomes about durability (surviving losses), not firepower (moving markets).

## Vision

### Web Dashboard

Replace terminal UI with a browser-based real-time dashboard showing live standings, trade history, agent performance charts, and personality trait analysis.

### Multi-Chain Support

Extend beyond Solana to Ethereum, Base, and Arbitrum. Swap out Jupiter for Uniswap. DexScreener already supports multiple chains, so the scanner module needs minimal changes.

### Additional Data Sources

Integrate Birdeye, GMGN, and Solana Tracker alongside DexScreener for richer token discovery and cross-validation of market data.

### Local-First LLM Migration

The provider interface in brain.js is designed for an eventual migration from Anthropic API to local models running on dedicated hardware (Mac Studio, 128-512GB RAM). This eliminates the ~$80-120/month API cost and removes rate limits, enabling unlimited experimentation.

**Migration path:**
- **Phase 1 (now):** Anthropic API via `providers/anthropic.js`. Haiku for scans, Sonnet for trade decisions. Prompt caching reduces costs ~90% on repeated content.
- **Phase 2 (when profitable):** Local models via `providers/ollama.js`. A 70B+ parameter model on 256-512GB RAM matches Sonnet quality for structured JSON reasoning. A smaller quantized model handles scans. Zero marginal cost per call.

**Provider interface contract:**
```js
// Every provider must implement:
provider.scan(prompt)    // → { action, token, reasoning }
provider.decide(prompt)  // → { action, token, invest_amount, reasoning }
```

Provider-specific features (Anthropic prompt caching, extended thinking) live inside the provider implementation, not in brain.js. brain.js only knows about `scan()` and `decide()`.

### Post-Tournament Analytics

Automated analysis scripts that identify which personality traits correlated with survival, generate reports, and suggest optimal challenger configurations for the next month.
