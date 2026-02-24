// Anthropic provider: Haiku for scans, Sonnet for trade decisions, with prompt caching.

import Anthropic from '@anthropic-ai/sdk';
import { retry, log } from '../utils.js';
import 'dotenv/config';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCAN_MODEL = 'claude-haiku-4-5-20251001';
const DECIDE_MODEL = 'claude-sonnet-4-5-20250929';
const THINKING_BUDGET = 4096;

// Cost per million tokens (input/output) for estimation.
const COSTS = {
  [SCAN_MODEL]: { input: 1, output: 5 },
  [DECIDE_MODEL]: { input: 3, output: 15 }
};

// Extract the text content from a message response, handling thinking blocks.
function extractText(message) {
  for (const block of message.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

// Build usage object from the API response.
function extractUsage(message) {
  return {
    input_tokens: message.usage?.input_tokens || 0,
    output_tokens: message.usage?.output_tokens || 0,
    cache_read_input_tokens: message.usage?.cache_read_input_tokens || 0,
    cache_creation_input_tokens: message.usage?.cache_creation_input_tokens || 0
  };
}

// Estimate cost in USD from token usage.
export function estimateCost(model, usage) {
  const rates = COSTS[model] || COSTS[DECIDE_MODEL];
  const inputCost = (usage.input_tokens / 1_000_000) * rates.input;
  const outputCost = (usage.output_tokens / 1_000_000) * rates.output;
  // Cached reads cost 10% of base input
  const cacheCost = (usage.cache_read_input_tokens / 1_000_000) * rates.input * 0.1;
  // Cache creation costs 25% more than base input
  const creationCost = (usage.cache_creation_input_tokens / 1_000_000) * rates.input * 1.25;
  return inputCost + outputCost + cacheCost + creationCost;
}

// Lightweight scan: evaluate token candidates with the fast model.
// Uses prompt caching on the system prompt since it's repeated across agents.
export async function scan(prompt) {
  const message = await retry(
    () => client.messages.create({
      model: SCAN_MODEL,
      max_tokens: 256,
      system: [{
        type: 'text',
        text: 'You are a Solana token trading agent. Evaluate tokens and respond with JSON only.',
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{ role: 'user', content: prompt }]
    }),
    { attempts: 3, baseDelay: 2000, label: 'anthropic scan' }
  );

  const text = extractText(message);
  const tokenUsage = extractUsage(message);
  const cost = estimateCost(SCAN_MODEL, tokenUsage);

  log.debug(`Scan: ${tokenUsage.input_tokens}in/${tokenUsage.output_tokens}out, cache_read=${tokenUsage.cache_read_input_tokens}, ~$${cost.toFixed(4)}`);

  return { text, usage: tokenUsage, cost };
}

// Full trade decision: deep reasoning with extended thinking and the strong model.
// Uses prompt caching on the system prompt for cost reduction.
export async function decide(prompt) {
  const message = await retry(
    () => client.messages.create({
      model: DECIDE_MODEL,
      max_tokens: THINKING_BUDGET + 1024,
      thinking: {
        type: 'enabled',
        budget_tokens: THINKING_BUDGET
      },
      system: [{
        type: 'text',
        text: 'You are a Solana token trading agent in a survival tournament. Think carefully about your decision. Respond with JSON only after your reasoning.',
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{ role: 'user', content: prompt }]
    }),
    { attempts: 3, baseDelay: 3000, label: 'anthropic decide' }
  );

  const text = extractText(message);
  const tokenUsage = extractUsage(message);
  const cost = estimateCost(DECIDE_MODEL, tokenUsage);

  // Extract thinking content for logging
  const thinking = message.content.find(b => b.type === 'thinking');
  if (thinking) {
    log.debug(`Decide thinking: ${thinking.thinking.slice(0, 200)}...`);
  }

  log.debug(`Decide: ${tokenUsage.input_tokens}in/${tokenUsage.output_tokens}out, cache_read=${tokenUsage.cache_read_input_tokens}, ~$${cost.toFixed(4)}`);

  return { text, usage: tokenUsage, cost, thinking: thinking?.thinking || null };
}
