# Darwin — AI Trading Agent Survival Tournament

## Overview

Darwin is a Node.js application that runs 100 autonomous AI trading agents in a monthly survival tournament. Each agent trades newly launched tokens on Solana DEXes, competing to maximize returns while avoiding elimination. The bottom 50 agents are eliminated each month, and 50 new challengers replace them. Over time, the system discovers which trading personalities and strategies survive real market conditions.

This is not a framework project. No OpenClaw, no heavyweight dependencies. It's a self-contained Node.js application that runs on a MacBook Pro M1 64GB as a background process.

---

## Architecture

```
darwin/
├── src/
│   ├── wallets.js          — Generate, fund, sweep, check balances for 101 wallets
│   ├── scanner.js          — Poll DexScreener API for new Solana token pairs
│   ├── safety.js           — Rug pull checks (RugCheck API, on-chain holder data, liquidity locks)
│   ├── brain.js            — LLM decision engine (Haiku for scans, Sonnet for trade decisions)
│   ├── trader.js           — Jupiter Swap API integration (buy/sell execution)
│   ├── monitor.js          — Price monitoring loop, exit trigger detection (+20%, -10%, rug)
│   ├── tournament.js       — Standings, rankings, shot tracking, elimination logic
│   ├── dashboard.js        — Terminal UI showing live tournament standings
│   └── index.js            — Main orchestrator, startup, scheduling
├── agents/
│   ├── agent-001/
│   │   ├── wallet.json     — Solana keypair (chmod 600)
│   │   ├── personality.json — Agent strategy configuration
│   │   └── history.json    — Full trade log, decisions, reasoning, P&L
│   ├── agent-002/
│   │   └── ...
│   └── ... (up to agent-100)
├── config/
│   ├── master-wallet.json  — Master wallet keypair (chmod 600, separate from agents)
│   ├── tournament-rules.json — Tournament parameters (shots, elimination count, etc.)
│   └── personalities.json  — All 100 personality definitions
├── logs/
│   └── daily/              — Daily snapshots of standings, market data, decisions
├── .env                    — API keys (Claude, RPC endpoint) — chmod 600
├── .gitignore              — Must exclude wallet.json files, .env, master-wallet.json
├── package.json
└── README.md
```

---

## Core Concepts

### 101 Wallets

- **Wallet 0 (Master):** The bank. Funds agents, sweeps dead/eliminated agents, tops up gas. Never trades. This is the only wallet the operator funds manually from an exchange.
- **Wallets 1–100 (Agents):** Each agent has its own isolated Solana wallet. Agents can only access their own wallet. Funded with $2 USDC each at the start of a tournament month.
- All wallets hold USDC as the base currency (stable accounting). Agents swap USDC → token when buying, token → USDC when selling.
- Each wallet also needs a small SOL balance (~$0.30) for transaction fees.

### Agent Personalities

Each agent has a unique personality defined across these dimensions:

**Entry timing** — how soon after token creation does the agent consider buying?
- Degen: minutes
- Early: 1–2 hours
- Patient: 4–12 hours
- Cautious: 24h+

**Token selection criteria** — what makes a token attractive?
- Volume chaser: highest early trading volume
- Liquidity snob: only high-liquidity tokens
- Social signal: requires Twitter/Telegram presence
- Contrarian: low volume but real liquidity
- Momentum reader: only if price is trending up
- Dip buyer: tokens that pumped, dipped, and are recovering

**Risk filtering** — how strict on safety checks?
- Yolo: minimal checks, maximizes trade count
- Balanced: moderate rug-pull filtering
- Paranoid: extensive checks (locked liquidity, holder distribution, contract mint revoked)

**Exit strategy:**
- Strict: exactly +20% / -10%
- Trailing: if it hits +15% and climbing, trailing stop
- Partial: sell half at +10%, rest at +20%
- Impatient: if no movement after 2 hours, exit at current price
- Diamond hands: wider stop-loss (-15%), bigger target (+30%)

**Position sizing** — how much of available balance to invest?
- All-in: 100%
- Aggressive: 80%, keep 20% reserve
- Balanced: 60%, keep 40% reserve
- Conservative: 40%, keep 60% reserve
- Adaptive: adjusts based on balance, standings, and recent results

**Self-preservation:**
- Reckless: trades every available opportunity
- Selective: will skip if nothing meets criteria
- Adaptive: becomes more conservative as balance grows
- Streak-aware: adjusts after consecutive wins/losses

### 100 Agent Distribution

Organize agents into 5 experimental groups:

**Group A (20 agents) — Entry timing test:**
Vary entry timing × exit strategy. Keep selection, risk filtering constant.
→ Isolates: does entry speed matter?

**Group B (20 agents) — Selection criteria test:**
Vary selection method × position sizing. Keep entry, filtering constant.
→ Isolates: what token-picking method works?

**Group C (20 agents) — Risk filtering test:**
Vary risk level × self-preservation style. Keep entry, selection constant.
→ Isolates: how much safety checking is optimal?

**Group D (20 agents) — Position sizing + reserve test:**
Vary sizing strategy × competitive aggression. Keep other dims constant.
→ Isolates: is bankroll management the key variable?

**Group E (20 agents) — "Let the LLM cook":**
No fixed strategy — only free-form personality descriptions like "aggressive and impulsive", "analytical and patient", "paranoid, only acts on certainty". The LLM decides the strategy.
→ Isolates: can the LLM discover strategies the structured agents miss?

### Tournament Rules

- **Duration:** 31 days per month
- **Shots:** Each agent gets 31 shots (trade attempts) per month. An agent decides when to use them — not forced to trade daily. Can use multiple shots in one day or skip days entirely.
- **Elimination:** Bottom 50 agents by final balance are eliminated at month end.
- **Death:** An agent whose total balance (investable + reserve) reaches ~$0 is dead for the remainder of the month. Dead agents are automatically ranked last.
- **Competition awareness:** Each agent receives daily standings showing all agents' ranks and balances (but NOT their strategies). This creates competitive pressure.
- **Position sizing freedom:** Agents decide how much of their balance to invest vs. keep in reserve. Reserve funds survive a rug pull.

### Evolution (Month 2+)

- Top 50 agents continue with their existing wallets and balances (capital advantage)
- Bottom 50 are swept and replaced with 50 new challengers
- New challengers are designed based on analysis of month 1: what traits correlated with survival and performance?
- New challengers get $2 fresh funding
- This creates natural selection: winning strategies persist and evolve

---

## External APIs & Services

### DexScreener API (Discovery)
- **Purpose:** Find newly created token pairs on Solana
- **Endpoint:** `https://api.dexscreener.com/token-pairs/v1/solana/{address}` and new pairs endpoints
- **Cost:** Free, no API key required
- **Rate limits:** Be respectful, poll every few minutes (not seconds)
- **Data returned:** Pair address, base/quote token, price USD, volume, liquidity, pair creation timestamp, price change %, transactions

### RugCheck (Safety)
- **Purpose:** Assess token safety before buying
- **Check:** Liquidity locks, mint authority, holder concentration, contract risks
- **Also check on-chain via Solana RPC:** holder distribution, top wallet %, whether liquidity is locked and for how long

### Claude API via Anthropic SDK (Brain)
- **Haiku 4.5** ($1/$5 per MTok): Used for routine scans — "anything worth looking at right now?" ~70% of calls
- **Sonnet 4.5** ($3/$15 per MTok): Used for actual trade decisions — "given this data, my personality, my standings, should I trade?" ~30% of calls
- **Prompt caching:** Use for system prompts, personality definitions, and tournament rules — saves ~90% on repeated input tokens
- **Extended thinking:** Enable for Sonnet trade decisions (these are high-stakes choices worth deeper reasoning)

### Jupiter Swap API (Execution)
- **Purpose:** Execute token swaps on Solana
- **Flow:** Quote → Swap → Sign → Submit
- **Endpoint:** `https://quote-api.jup.ag/v6/quote` and `/v6/swap`
- **Cost:** Free API. Transaction fees ~$0.005–0.01 per swap in SOL.
- **Slippage:** Set appropriate slippage tolerance. For new low-liquidity tokens, expect 1–5%.

### Solana RPC
- **Purpose:** Check balances, submit transactions, read on-chain data
- **Options:** Helius, QuickNode, or Alchemy free tier. Public RPCs work but are rate-limited.
- **Needed for:** Balance checks, transaction submission, holder data queries

---

## Agent Decision Flow

Each agent runs this loop independently:

```
CONTINUOUS SCAN (every few minutes):
│
├─ Call DexScreener → get new Solana pairs
├─ Basic filter (code, no LLM): age, minimum liquidity, minimum volume
├─ If nothing passes filter → sleep, retry later
│
├─ Candidates found → LLM SCAN (Haiku):
│  Prompt: "Here are 5 new tokens with their stats. 
│           Given your personality, are any worth investigating?"
│  If no → sleep, retry later
│
├─ Token of interest → SAFETY CHECK (code + API):
│  ├─ RugCheck score
│  ├─ Liquidity locked? For how long?
│  ├─ Mint authority revoked?
│  ├─ Top holder concentration
│  └─ Compile safety report
│
├─ Safety report → LLM DECISION (Sonnet, extended thinking):
│  Prompt includes:
│  ├─ Token data + safety report
│  ├─ Agent personality definition
│  ├─ Current balance (investable + reserve)
│  ├─ Shots remaining this month
│  ├─ Full tournament standings (ranks + balances, not strategies)
│  ├─ Agent's own trade history this month
│  └─ "Decide: SKIP, TRADE (amount + token), or ADJUST RESERVE"
│
│  If SKIP → log reasoning, retry later
│  If ADJUST RESERVE → move funds between investable/reserve, log
│  If TRADE:
│
├─ EXECUTE BUY (Jupiter):
│  ├─ Get quote (USDC → token)
│  ├─ Check slippage is acceptable
│  ├─ Execute swap
│  ├─ Confirm transaction on-chain
│  └─ Record entry price, amount, timestamp
│
├─ MONITOR POSITION (code only, no LLM):
│  ├─ Poll price every 1–2 seconds
│  ├─ Check: price >= entry × 1.20? → SELL (take profit)
│  ├─ Check: price <= entry × 0.90? → SELL (stop loss)
│  ├─ Check: liquidity dropping sharply? → SELL (rug detection)
│  ├─ Check: agent's exit strategy modifiers (trailing stop, impatient timer, etc.)
│  └─ Loop until exit triggered
│
├─ EXECUTE SELL (Jupiter):
│  ├─ Get quote (token → USDC)
│  ├─ Execute swap
│  ├─ Confirm transaction
│  └─ Record exit price, P&L, hold duration
│
└─ LOG EVERYTHING:
   ├─ Token considered, safety data, LLM reasoning
   ├─ Trade execution details (entry, exit, slippage, fees)
   ├─ P&L for this trade
   ├─ Updated balance and reserve
   ├─ Shots remaining
   └─ Write to agent's history.json
```

---

## LLM Prompt Templates

### Scan Prompt (Haiku)

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

### Trade Decision Prompt (Sonnet, with extended thinking)

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

You must decide:
1. SKIP — do not trade. Save your shot for later.
2. TRADE — specify the token address and EXACTLY how much USDC to invest (you do not have to invest everything).
3. ADJUST_RESERVE — move USDC between your investable balance and reserve.

Respond with a JSON object:
{
  "action": "skip" | "trade" | "adjust_reserve",
  "token": "address if trading",
  "invest_amount": number_if_trading,
  "reserve_adjustment": number_if_adjusting (positive = add to reserve, negative = withdraw from reserve),
  "reasoning": "your full thought process"
}
```

---

## Key Technical Decisions

### Concurrency
- 100 agents run as concurrent async tasks in a single Node.js process
- Each agent has its own scan/trade loop with randomized timing to avoid all agents hitting APIs simultaneously
- Use a shared DexScreener cache — scan once, share data across all agents rather than 100 identical API calls

### State Persistence
- All state is JSON files on disk
- On startup, each agent loads its wallet, personality, history, and resumes
- After every trade or decision, state is written to disk immediately
- This means a crash or restart loses nothing — agents pick up exactly where they left off

### Error Handling
- Failed API calls (DexScreener, Jupiter, Claude) → retry with exponential backoff
- Failed transactions (Solana network issues) → retry up to 3 times, then skip
- Jupiter quote but swap fails → do NOT count as a used shot
- Agent crashes → log error, restart that agent's loop, do not affect others

### Security
- All wallet JSON files: chmod 600
- Master wallet key stored separately from agent keys
- .env file with API keys: chmod 600
- .gitignore must exclude: `**/wallet.json`, `.env`, `config/master-wallet.json`
- Each agent wallet is funded with minimal amounts ($2 + gas)
- Master wallet holds only the tournament's total capital, nothing else
- Use a dedicated Solana wallet for this experiment, never connected to other holdings

### Paper Trading Mode
- Build a --paper flag that simulates trades without executing on-chain
- Paper mode: tracks theoretical P&L based on real DexScreener prices
- Essential for testing the full pipeline before risking real money
- All agent logic, LLM calls, and decisions work identically — only the Jupiter execution is mocked

---

## Build Order

### Phase 1 — Foundation
1. Project scaffold: package.json, directory structure, .gitignore, .env template
2. `wallets.js`: Generate 101 Solana keypairs, save securely, function to check balances
3. `wallets.js`: Funding script — master wallet distributes $2 USDC + $0.30 SOL to each agent
4. Config: `personalities.json` — define all 100 agent personalities across the 5 groups (A–E)

### Phase 2 — Data Pipeline
5. `scanner.js`: Poll DexScreener for new Solana pairs, parse and normalize response data
6. `scanner.js`: Shared cache layer — scan once, make data available to all agents
7. `safety.js`: RugCheck API integration — get safety score for a token
8. `safety.js`: On-chain checks via Solana RPC — holder distribution, liquidity lock, mint authority

### Phase 3 — Brain
9. `brain.js`: Anthropic SDK setup with prompt caching for system prompts
10. `brain.js`: Haiku scan function — takes token data + personality, returns investigate/skip
11. `brain.js`: Sonnet decision function — takes full context (token, safety, standings, history), returns trade/skip/adjust

### Phase 4 — Execution
12. `trader.js`: Jupiter quote function — get best swap route for USDC → token
13. `trader.js`: Jupiter swap function — execute the swap, sign with agent's keypair
14. `trader.js`: Paper trading mock — simulate execution with real prices but no on-chain tx
15. `monitor.js`: Price monitoring loop — poll token price, detect exit conditions (+20%, -10%, rug indicators)
16. `trader.js`: Sell execution — token → USDC swap when exit triggers

### Phase 5 — Tournament
17. `tournament.js`: Shot tracking per agent
18. `tournament.js`: Daily standings calculation — read all agent wallet balances, rank them
19. `tournament.js`: Death detection — mark agents with $0 balance as dead
20. `tournament.js`: Month-end elimination — identify bottom 50, sweep their funds to master

### Phase 6 — Orchestration
21. `index.js`: Main loop — initialize all agents, start their concurrent scan/trade loops
22. `index.js`: Graceful shutdown — save all state on SIGINT/SIGTERM
23. `index.js`: Startup recovery — load state from disk, resume where left off
24. `dashboard.js`: Terminal UI — live standings table, recent trades, agent status

### Phase 7 — Testing & Launch
25. Full pipeline test in paper trading mode with 5 agents
26. Scale to 100 agents in paper trading mode — verify concurrency, API rate limits
27. Fund master wallet with real USDC + SOL
28. Run funding script to distribute to 100 agent wallets
29. Launch with real trading — monitor closely for first 24–48 hours
30. Set up basic alerting (console logs or optional Telegram notifications for deaths, big wins)

---

## Dependencies

```json
{
  "dependencies": {
    "@solana/web3.js": "^1.x",
    "@solana/spl-token": "^0.3.x",
    "@jup-ag/api": "latest",
    "@anthropic-ai/sdk": "latest",
    "node-cron": "^3.x",
    "dotenv": "^16.x",
    "chalk": "^5.x"
  },
  "devDependencies": {
    "nodemon": "^3.x"
  }
}
```

Minimal. No frameworks, no unnecessary abstractions.

---

## .env Template

```
# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Solana RPC
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...

# Mode
PAPER_TRADING=true

# Optional: Telegram notifications
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## .gitignore

```
node_modules/
.env
config/master-wallet.json
agents/**/wallet.json
logs/
*.log
.DS_Store
```

---

## Monthly Budget

| Item | Cost |
|---|---|
| Capital (one-time, partially recoverable) | $200 |
| Claude API (Haiku scans + Sonnet decisions, cached) | ~$80–120/mo |
| Solana RPC (free tier) | $0 |
| SOL transaction fees | ~$2/mo |
| **Total month 1** | **~$300** |
| **Ongoing months** | **~$100–125** |

---

## Important Notes

- **Start in paper trading mode.** Get the full pipeline working with simulated trades before risking real money. The LLM calls are real (and cost money), but the trades are simulated.
- **USDC is the base currency.** All P&L is denominated in USDC, not SOL. This avoids SOL price fluctuations affecting the experiment.
- **Security matters.** Wallet keys must never be committed to git. File permissions must be set correctly. Use a dedicated wallet funded only with experiment capital.
- **The LLM is not the trader.** The LLM makes the decision (what to buy, how much). Code handles execution, monitoring, and exits. The LLM never touches wallet keys or executes transactions directly.
- **Log everything.** Every scan, every decision (including skips), every trade, every reasoning chain. This data is the real output of the experiment — it tells you which strategies work and why.
- **Rug pulls will happen.** An agent can lose 100% despite a -10% stop-loss if liquidity disappears instantly. This is expected and is part of the survival pressure. Agents with good safety filtering and position sizing (reserves) should survive these events.

---

## Open Source Strategy

### License
MIT — keep it simple, maximum adoption.

### What the repo contains
- Complete tournament framework
- All agent personality templates
- Paper trading mode (works out of the box with just a Claude API key)
- Example configurations for 10, 50, and 100 agents
- Full documentation

### What the repo does NOT contain
- Wallet keys, API keys, or any secrets
- Evolved/optimized personality configurations from real runs
- Real trading results or performance data
- Any financial advice or guarantees

### Customization points for contributors
- **New personality dimensions:** add new behavioral axes beyond the 6 built-in ones
- **New chains:** Ethereum, Base, Arbitrum — swap out Jupiter for Uniswap, DexScreener works across chains
- **New data sources:** add Birdeye, GMGN, Solana Tracker alongside DexScreener
- **New LLM providers:** OpenAI, DeepSeek, local Ollama models — the brain.js interface is model-agnostic
- **New exit strategies:** more sophisticated exit logic (TWAP selling, partial exits, etc.)
- **Web dashboard:** replace terminal UI with a browser-based real-time dashboard
- **Analytics:** post-month analysis scripts that identify which personality traits correlated with survival
- **Notifications:** Telegram, Discord, Slack alerts for deaths, big wins, milestones

### README.md Structure (for the public repo)
1. One-liner: "100 AI trading agents compete in a survival tournament. The best strategies evolve."
2. 30-second GIF of the terminal dashboard showing live standings
3. Quick start: clone, npm install, set ANTHROPIC_API_KEY, run in paper mode
4. Architecture overview (simplified)
5. How to define custom agent personalities
6. How to run a tournament
7. How to analyze results
8. Contributing guide
9. Disclaimer: not financial advice, use at your own risk, you are responsible for your own funds

### Disclaimer (MUST be prominent in README and LICENSE)
```
DISCLAIMER: Darwin is an experimental research tool for studying AI decision-making 
strategies. It is NOT financial advice. Trading cryptocurrency, especially newly 
launched tokens, carries extreme risk including total loss of capital. The authors 
and contributors are not responsible for any financial losses. Use at your own risk. 
Always understand the code you run and the financial implications of automated trading.
```
