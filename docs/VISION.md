# Vision

## One-Liner

100 AI agents compete in a survival tournament on Solana. The best decision-making strategies evolve. The reasoning data is the product.

## The Problem

Every day, thousands of new tokens launch on Solana DEXes. Most are worthless or outright scams. A few generate real returns. No human can scan, evaluate, and trade across this volume in real time. Existing trading bots are either too simple (fixed rules) or too opaque (black-box ML). Nobody is systematically testing which AI decision-making strategies actually work in live markets.

## The Experiment

Darwin is a controlled experiment in AI trading strategy evolution. Instead of building one "perfect" trading bot, we build 100 agents with deliberately different personalities and let them compete under real market conditions. The tournament structure creates natural selection pressure: strategies that work survive, strategies that don't are eliminated and replaced.

This produces something no backtesting simulation can: validated insights about which decision-making traits (timing, risk tolerance, position sizing, exit discipline) actually matter when real money is on the line.

## What Makes Darwin Different

### Tournament-Driven Evolution

Most AI trading projects optimize a single strategy. Darwin runs 100 strategies in parallel and lets the market decide which survive. After each month, the bottom 50 are eliminated. But replacement isn't random -- it's structured like biological evolution:

- **Analysis:** Which personality dimensions (not whole agents) correlated with survival?
- **Crossover:** New challengers recombine winning traits in novel configurations.
- **Mutation:** Some challengers deliberately test contrarian hypotheses against the winners' patterns.
- **Selection pressure:** Survivors keep their existing capital. Challengers start fresh with $5, testing whether strategy can overcome a capital disadvantage.

Each month produces a new generation. Over time, this creates genuine natural selection for trading strategies.

### Personality-Based AI Agents

Each agent has a distinct personality defined across six dimensions (entry timing, token selection, risk filtering, exit strategy, position sizing, self-preservation). This isn't random variation -- it's a structured experiment with control groups isolating specific variables. Group E ("let the LLM cook") tests whether AI can discover strategies the structured agents miss.

### Survival as the Core Mechanic

The tournament isn't just a ranking system -- it's an existential game. Each agent is told in every decision prompt: "If your total balance reaches $0, you are permanently dead. You cease to exist." This framing creates a tension that drives the entire experiment.

The most interesting behavioral question isn't "which agent makes the most money?" -- it's "how does an AI balance performance against survival?" A conservative agent that never trades will survive but rank last. An aggressive agent that trades every opportunity will either climb fast or die fast. The optimal strategy lives somewhere in between, and the tournament discovers where.

Critically, doing nothing is always an option. Every agent can SKIP -- save the shot for later. The permission to wait, to be patient, to refuse a trade despite pressure, is a design choice. Some agents will use all 31 shots in the first week. Others will hoard them for the final days. The flexibility is intentional: agents that manage their shots well have an advantage that transcends strategy.

### Competitive Pressure Changes Everything

Every agent sees the full tournament standings: who's alive, who's dead, everyone's rank and balance. But no agent knows another's strategy. This creates a game-theoretic layer on top of the trading decisions.

A leader with $3.50 and rank #2 faces a fundamentally different decision than an agent at rank #48 with $1.10 and 5 days left. The leader has something to protect. The laggard has nothing to lose. Mid-pack agents face the hardest choices: every trade either saves them or kills them.

This positional awareness means the same token, at the same price, with the same safety profile, can produce completely different decisions from different agents -- not because of their personality, but because of their tournament position. That interaction between personality and position is what makes Darwin's data valuable.

### Real Money, Real Consequences

Paper trading mode exists for development and testing, but the experiment is designed for real on-chain execution. Agents trade with real USDC on Solana DEXes. Rug pulls, slippage, and liquidity crises are features of the experiment, not bugs. An agent can lose 100% of a position despite a -10% stop-loss if liquidity disappears instantly. Agents with good safety filtering and reserve management survive these events. Others don't.

### Transparent Decision-Making

Every decision is logged: what the agent saw, what it considered, why it acted or didn't. This includes skips -- an agent that chose not to trade is just as interesting as one that did. This creates a rich dataset for post-tournament analysis. The LLM's reasoning is visible, not a black box.

## Strategic Positioning

### Research Tool, Not Financial Product

Darwin is an experimental research tool for studying AI decision-making under competitive survival pressure. It is not a hedge fund, not a trading signal service, not financial advice. This distinction is fundamental to the project's identity and legal positioning.

The trading is the mechanism. The decision-making data is the product. Even if no agent makes money, the dataset of 100 differently-prompted LLMs reasoning under existential stakes, competitive pressure, and uncertainty is a genuinely novel research contribution. How does an agent that's told "you cease to exist at $0" reason differently than one that isn't? How does a leader protect its position vs. a laggard gambling for survival? These questions are interesting regardless of P&L.

### Open Source First

The complete framework is open source (MIT). Anyone can run their own tournament with their own strategies. The value isn't in the code -- it's in the data and insights generated by running it. Open sourcing builds community, attracts contributors, and establishes credibility.

For GitHub positioning, lead with the AI research angle: "A study of how AI agents reason under competitive survival pressure" is more interesting and more durable than "AI trading bots." The trading is the pressure mechanism. The reasoning logs are the output.

### Extensibility as a Moat

Darwin is designed to be extended:
- New chains (Ethereum, Base, Arbitrum)
- New data sources (Birdeye, GMGN)
- New LLM providers (OpenAI, DeepSeek, local models)
- New personality dimensions and exit strategies
- Web dashboard replacing terminal UI
- Post-tournament analytics

Community contributions expand the experiment's scope without centralized effort.

## Long-Term Direction

### Month 0: Paper Tournament

Full 31-day dry run with paper trading. Real API calls, real market data, simulated execution. Validates the pipeline, calibrates API costs, reveals shot pacing patterns, and produces the first reasoning dataset. Cost: ~$120 in API calls, zero capital risk. This is not optional.

### Month 1: Baseline

Run the first real tournament with 100 agents across 5 experimental groups at $5 each. Establish baseline data on which personality dimensions correlate with survival. Validate the pipeline end-to-end with real money.

### Months 2-6: Evolution

Apply structured evolutionary pressure. Analyze month 1 survivors to identify which specific personality dimensions (entry timing? risk filtering? position sizing?) predicted survival. Design 50 challengers that recombine winning traits in new ways. Test whether evolved strategies outperform the baseline generation. Track whether specific trait combinations emerge as dominant or whether success remains context-dependent.

### Beyond: Platform

If the experiment produces meaningful insights, Darwin becomes a platform for ongoing AI trading research. The framework, the personality system, and the tournament structure are the contribution. The specific trading results are secondary.
