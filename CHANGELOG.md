# Changelog

All notable changes to Darwin are documented in this file.

## [0.3.0] - 2026-03-01

### Added

- Main orchestrator (src/index.js): concurrent agent loops with staggered starts, crash isolation per agent, inter-cycle delays, decision logging, startup recovery for open positions (Closes #20)
- Graceful shutdown (src/index.js): SIGINT/SIGTERM handlers, subsystem teardown, 30s timeout for agent loops, final standings update, usage summary (Closes #21)
- Tournament state (src/tournament.js): shot tracking, trade accounting, balance calculation with reserve system (Closes #16)
- Standings calculation (src/tournament.js): ranking by balance, death detection at threshold, daily snapshots (Closes #17)
- Month-end elimination (src/tournament.js): bottom-N elimination with fund sweeping back to master wallet (Closes #18)
- Circuit breaker (src/tournament.js): mass death detection with configurable threshold and day cutoff (Closes #19)
- Terminal dashboard (src/dashboard.js): live top-10 standings, near-cutoff agents, recent trades, system stats with auto-refresh (Closes #22)
- 100-agent paper tournament running successfully (Closes #23, #24)

### Changed

- Safety gate to advisory model: only confirmed honeypots (rugged + freeze authority) are hard-blocked, all other risk levels pass through as context for agent decisions (Closes #32)
- Scanner poll interval from 5 minutes to 1 minute for faster token throughput (Closes #31)
- Scanner minimum token age from 30 minutes to 5 minutes to catch early momentum (Closes #33)
- Extended thinking capture in decide responses for richer decision logging
- Agent runtime data (state, decisions, history) excluded from git via .gitignore
- Research findings (docs/RESEARCH.md) excluded from git — private content

## [0.2.0] - 2026-02-24

### Added

- Integration test with 5 agents in paper mode validated end-to-end pipeline

## [0.1.0] - 2026-02-24

### Added

- Project scaffold: package.json (ES modules), directory structure, .env.example (Closes #1)
- Shared utilities (src/utils.js): atomic JSON read/write, structured logging, retry with exponential backoff, agent path helpers
- Wallet management (src/wallets.js): keypair generation, disk persistence with chmod 600, SOL and USDC balance queries (Closes #2)
- Wallet funding and sweeping (src/wallets.js): fund agents from master wallet (USDC + SOL), sweep eliminated agents back to master, CLI interface (Closes #3)
- Agent personality definitions (config/personalities.json): 100 agents across 5 experimental groups of 20 (Closes #4)
  - Group A: entry timing x exit strategy
  - Group B: token selection x position sizing
  - Group C: risk filtering x self-preservation
  - Group D: position sizing x competitive aggression
  - Group E: free-form creative personalities
- Tournament rules (config/tournament-rules.json): all parameters from spec ($25 cap, 31 shots, 100 agents, circuit breaker thresholds)
- LLM provider interface (src/brain.js): provider-agnostic scan/decide functions, prompt assembly matching spec templates, JSON response parsing and validation, per-trade cap enforcement with clamping, token usage tracking (Closes #29)
- Anthropic provider (src/providers/anthropic.js): Haiku for scans with prompt caching, Sonnet for trade decisions with extended thinking + prompt caching, retry with backoff, cost estimation
- Token scanner (src/scanner.js): DexScreener polling (profiles + batch pairs), in-memory cache with TTL eviction, per-agent dedup, rate limiting, pre-filtering by liquidity/volume/age (Closes #5)
- Safety scoring (src/safety.js): external safety score integration with 15-min cache, graceful failure handling (Closes #6)
- On-chain safety checks (src/safety.js): mint/freeze authority verification, top-holder concentration analysis via largest accounts (Closes #7)
- Safety report compilation (src/safety.js): pool liquidity impact gate, parallel check orchestration, HIGH/MODERATE/LOW risk classification, formatted report string for decision engine (Closes #8)
- Scanner filter config (config/tournament-rules.json): token age bounds, volume floor, cache TTL, max cache size
- DEX swap execution (src/trader.js): quote fetching with retry, buy execution with per-trade cap enforcement and price impact gating, paper mode branching (Closes #12)
- Sell execution (src/trader.js): token sell with 5x retry for stuck positions, P&L calculation, on-chain balance zero edge case handling (Closes #13)
- Paper trading mock (src/trader.js): paper buy/sell using aggregator quotes without on-chain transactions, position and history persistence (Closes #14)
- Position monitoring (src/monitor.js): shared price polling with batched DEX data fetches (30 tokens/request), per-agent exit trigger evaluation, rate limiting (200 req/min) (Closes #15)
- Personality-aware exit thresholds (src/monitor.js): strict, trailing_stop, impatient, diamond_hands strategies mapped to take-profit/stop-loss/timeout parameters
- Slippage config (config/tournament-rules.json): slippageBps 300 (3%), tunable per tournament
