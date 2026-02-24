# Changelog

All notable changes to Darwin are documented in this file.

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
