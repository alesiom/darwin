# Project

## Current Truth

### What Darwin Is

An experimental research tool that runs 100 autonomous AI trading agents in a monthly survival tournament on Solana DEXes. Each agent has a unique personality that drives its trading decisions. The bottom 50 are eliminated each month and replaced with new challengers. Over time, the system discovers which trading strategies survive real market conditions.

### What Darwin Is Not

- Not a hedge fund or trading signal service
- Not financial advice
- Not a framework or library for others to build on top of
- Not a guaranteed profit generator

### License

MIT -- maximum adoption, minimum friction.

### Tournament Rules

| Rule | Value |
|------|-------|
| Agents per tournament | 100 |
| Starting capital per agent | $5 USDC |
| Gas per agent | ~$0.30 SOL |
| Duration | 31 days |
| Shots per agent per month | 31 |
| Shot flexibility | Agents choose when to use shots -- multiple per day or skip days entirely |
| Take profit target | +20% |
| Stop loss | -10% |
| Competition visibility | Agents see all ranks + balances, but NOT other agents' strategies |
| Reserve system | Agents can set aside reserve funds that survive a total loss on a trade |
| Per-trade investment cap | $25 maximum per trade (enforced in prompt + code) |
| Minimum pool liquidity | Reject pools where cap exceeds 2% of liquidity (~$1,250 minimum) |
| Elimination | Bottom 50 by final balance |
| Death condition | Total balance (investable + reserve) reaches ~$0. Agent ceases to exist. |
| Mass death circuit breaker | If >70% of agents die before day 15, auto-pause and alert operator |
| Evolution | Top 50 continue with existing balances. Bottom 50 swept and replaced. |

### Per-Trade Investment Cap

**Problem:** An agent that starts with $5 and grows to $400 faces a fundamentally different market than it started in. A $400 buy into a $5,000 liquidity pool moves the price 8% on entry alone. Worse, the sell side is even more distorting. The experiment stops measuring strategy quality and starts measuring market impact. Additionally, scammers behind rug-pull tokens react differently to a $500 buy (pull liquidity, fat target) vs. a $5 buy (ignore). The agents stop operating in comparable market conditions.

**Solution:** A hard cap of $25 per trade, enforced at two levels:

1. **Prompt level:** The LLM sees "Maximum investment per trade: $25" in every trade decision prompt. It factors the constraint into its reasoning.
2. **Code level:** trader.js clamps any `invest_amount` to `min(requested_amount, cap)` before execution. If the LLM hallucinates a number above the cap, the code catches it. Clamping events are logged.

**Complementary filter:** safety.js rejects any pool where the $25 cap would exceed 2% of pool liquidity (pools under ~$1,250). This prevents market impact even when the cap itself is respected.

**Buy-side only.** The cap applies to entry trades. Sell-side exits the full position. If a token appreciated significantly, the pool grew proportionally, so selling is less distorting. On collapsed pools, monitor.js triggers early exits before the position becomes disproportionate.

**Configurable per month.** The cap lives in `tournament-rules.json`, not hard-coded. Month 0-1 at $25, adjustable based on data. If typical pool sizes turn out to be larger than expected, the cap can be raised in later months.

**How this changes position sizing:**

| Personality | With $5 balance | With $400 balance |
|-------------|----------------|-------------------|
| All-in (100%) | $5 (full balance) | $25 (capped) |
| Aggressive (80%) | $4 | $25 (capped, 80% of $400 = $320 > cap) |
| Balanced (60%) | $3 | $25 (capped) |
| Conservative (40%) | $2 | $25 (capped) |
| Adaptive | Varies | Capped at $25 regardless |

Early in the tournament, position sizing personalities differentiate meaningfully. As agents accumulate capital, the cap normalizes trade sizes. A rich agent's advantage becomes **durability** (can survive 16 consecutive $25 losses) rather than **firepower** (bigger bets). This keeps the experiment measuring strategy quality, not capital advantage.

### Agent Personality Dimensions

Each agent is defined across six dimensions:

**1. Entry Timing** -- how soon after token creation the agent considers buying
- Degen (minutes), Early (1-2h), Patient (4-12h), Cautious (24h+)

**2. Token Selection** -- what makes a token attractive
- Volume chaser, Liquidity snob, Social signal, Contrarian, Momentum reader, Dip buyer

**3. Risk Filtering** -- strictness on safety checks
- Yolo (minimal), Balanced (moderate), Paranoid (extensive)

**4. Exit Strategy** -- when and how to sell
- Strict (+20%/-10%), Trailing stop, Partial exits, Impatient (2h timeout), Diamond hands (+30%/-15%)

**5. Position Sizing** -- how much of available balance to invest
- All-in (100%), Aggressive (80%), Balanced (60%), Conservative (40%), Adaptive

**6. Self-Preservation** -- how the agent manages its survival
- Reckless, Selective, Adaptive, Streak-aware

### Adaptive Behavior from Tournament Position

Personality dimensions define an agent's baseline strategy, but tournament position changes behavior dynamically:

- **Leaders** (top 10) have an incentive to play defensively -- they're already advancing, so a reckless trade risks more than it gains.
- **Bottom 50** face elimination pressure. Some will go aggressive out of desperation. Others will freeze. The personality determines which.
- **Mid-pack agents** (ranks 30-60) face the hardest decisions. They're close enough to the cutoff that every trade matters, but not desperate enough to justify all-in gambles.
- **Agents near death** must weigh a small chance of survival against the certainty of doing nothing. Skipping preserves capital but doesn't climb the rankings.

This positional awareness is baked into every trade decision through the tournament standings injected into each prompt. The LLM sees where it stands and must factor that into its reasoning.

### Experimental Groups

| Group | Agents | Variable Tested | Isolates |
|-------|--------|----------------|----------|
| A | 20 | Entry timing x exit strategy | Does entry speed matter? |
| B | 20 | Selection method x position sizing | What token-picking works? |
| C | 20 | Risk level x self-preservation | How much safety checking is optimal? |
| D | 20 | Sizing strategy x competitive aggression | Is bankroll management key? |
| E | 20 | Free-form LLM personality | Can the LLM discover novel strategies? |

### Wallets

- **Wallet 0 (Master):** The bank. Funds agents, sweeps dead/eliminated agents, tops up gas. Never trades. Only wallet manually funded by operator.
- **Wallets 1-100 (Agents):** Each agent has its own isolated Solana wallet. Agents can only access their own wallet. Hold USDC as base currency.

### Monthly Budget

| Item | Cost |
|------|------|
| Phase 0: paper tournament dry run (API only) | ~$120 |
| Capital (one-time, partially recoverable) | $500 |
| Claude API (Haiku scans + Sonnet decisions, cached) | ~$80-120/mo |
| Solana RPC (free tier) | $0 |
| SOL transaction fees | ~$2/mo |
| **Total month 0 (paper)** | **~$120** |
| **Total month 1 (real)** | **~$600** |
| **Ongoing months** | **~$100-125** |

**Important:** The Claude Max subscription cannot be used for Darwin's programmatic API calls. Darwin requires a separate Anthropic API key with usage-based billing. The Max subscription covers interactive Claude usage only, not SDK/API access.

**Why $5 per agent instead of $2:** At $2, a +20% take profit is $0.40. With 3% slippage on entry and exit, $0.12 is lost to slippage alone -- 30% of the theoretical profit. At $5, the same trade nets $1.00 gross, and slippage takes $0.30 -- still significant but no longer dominant. The data becomes a measure of strategy quality rather than slippage noise.

### Build Phases

| Phase | Focus | Status |
|-------|-------|--------|
| 1. Foundation | Project scaffold, wallets, personality definitions | Not started |
| 2. Data Pipeline | DexScreener scanner, safety module (priority: pre-trade filtering) | Not started |
| 3. Brain | Claude SDK, Haiku scan, Sonnet trade decisions | Not started |
| 4. Execution | Jupiter swaps, paper trading, price + liquidity monitoring | Not started |
| 5. Tournament | Shot tracking, standings, death, elimination, circuit breaker | Not started |
| 6. Orchestration | Main loop, shutdown, recovery, terminal dashboard | Not started |
| 7. Paper Tournament | Full 31-day dry run, calibrate API costs and parameters | Not started |
| 8. Real Launch | Fund wallets, deploy, monitor first 48 hours closely | Not started |

**Phase 2 note:** Safety.js (pre-trade filtering) is more important than monitor.js (post-trade exit detection). A great safety module prevents rug-pull losses entirely. A stop-loss only limits them -- and on Solana, single-block rug pulls can bypass any exit strategy. Prioritize the safety pipeline.

**Phase 7 note:** The paper tournament is not optional. It's a full 31-day simulation with real API calls (cost ~$120) and zero capital risk. It validates API costs, reveals shot pacing patterns, tests the mass death circuit breaker, and produces the first dataset for analysis. Every parameter assumption should be checked against paper results before committing real money.

### Hosting

| Service | Platform |
|---------|----------|
| Source code (primary) | GitLab (private) |
| Source code (mirror) | GitHub (public, open source) |
| Runtime | MacBook Pro M1 64GB (background process) |

### Open Source Strategy

**Public (GitHub):**
- Complete tournament framework
- All agent personality templates
- Paper trading mode
- Example configurations (10, 50, 100 agents)
- Full documentation
- MIT license

**Private:**
- Wallet keys, API keys, secrets
- Evolved personality configurations from real runs
- Real trading results and performance data

### Dependencies

Minimal. No frameworks, no unnecessary abstractions.

| Package | Purpose |
|---------|---------|
| `@solana/web3.js` | Solana blockchain interaction |
| `@solana/spl-token` | SPL token operations |
| `@jup-ag/api` | Jupiter DEX aggregator |
| `@anthropic-ai/sdk` | Claude AI decisions |
| `node-cron` | Scheduling |
| `dotenv` | Environment configuration |
| `chalk` | Terminal UI styling |

## Vision

### Evolution System

After each month, the evolution process follows a structured experimental design:

1. **Analyze survivors:** Which personality dimensions correlate with survival? Did cautious agents outperform degens? Did reserve management matter more than entry timing?
2. **Identify winning traits:** Extract the specific dimension values (not whole personalities) that appeared disproportionately in the top 50.
3. **Design challengers:** Create 50 new agents that combine winning dimensions in new configurations. This isn't copying winners -- it's recombining their traits to test whether the combination matters or individual dimensions dominate.
4. **Introduce variation:** Some challengers are direct recombinations of winning traits. Others deliberately test contrarian hypotheses (e.g., "degens survived, but would a degen with paranoid safety filtering do even better?").
5. **Preserve control:** Top 50 survivors continue with their existing wallets and capital advantage. New challengers start with $5. This tests whether strategy can overcome capital disadvantage.

This creates actual natural selection with crossover and mutation, not just "keep the best, replace the rest."

### Analytics Pipeline

Post-tournament analysis scripts that correlate personality dimensions with survival and performance. Generate automated reports identifying which traits matter most.

### Community Tournaments

Enable others to run their own tournaments with custom configurations, different chains, different LLM providers. The framework is the product, not the specific results.

### Notification System

Telegram, Discord, or Slack alerts for significant events: agent deaths, big wins, milestones, end-of-month results.
