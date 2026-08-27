// Owner: Intake (A). Turns a messy free-text SMS into a structured order.
// This is the honest "interpret messy information" step of the agent.
// Falls back to a keyword parser when no ANTHROPIC_API_KEY is set, so the
// pipeline works offline during early development.

const cfg = require('./config');

let client = null;
function anthropic() {
  if (client) return client;
  if (!cfg.claude.apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  client = new Anthropic({ apiKey: cfg.claude.apiKey });
  return client;
}

function keywordParse(text) {
  const items = [];
  // Split on the joins people actually type, so "3 doors and 2 gates" does not
  // collapse into one item called "doors and 2 gates".
  const parts = String(text).split(/\s+and\s+|\s+plus\s+|[,;]|then/i);
  const re = /(\d+)\s*(?:x|pcs|pieces|pc)?\s*([a-z][a-z0-9"'\-\s]{2,30}?)(?=\s+(?:by|before|on|for|to)\s+|$)/i;
  for (const part of parts) {
    const m = re.exec(part.trim());
    if (m) items.push({ name: m[2].trim(), qty: parseInt(m[1], 10) });
  }
  if (items.length === 0) {
    items.push({ name: (text.slice(0, 40).trim() || 'unspecified item'), qty: 1 });
  }
  return { items, requested_delivery: '', notes: 'keyword-parsed (no LLM key)' };
}

async function parseOrder(rawText) {
  const c = anthropic();
  if (!c) return keywordParse(rawText);
  try {
    const msg = await c.messages.create({
      model: cfg.claude.model,
      max_tokens: 400,
      tools: [{
        name: 'record_order',
        description: 'Extract a manufacturing order from a customer message.',
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, qty: { type: 'integer' } },
                required: ['name', 'qty'],
              },
            },
            requested_delivery: { type: 'string', description: 'ISO date or empty string' },
            notes: { type: 'string' },
          },
          required: ['items'],
        },
      }],
      tool_choice: { type: 'tool', name: 'record_order' },
      messages: [{ role: 'user', content: `Customer SMS: "${rawText}"` }],
    });
    const call = msg.content.find((x) => x.type === 'tool_use');
    if (call && Array.isArray(call.input.items) && call.input.items.length) return call.input;
    return keywordParse(rawText);
  } catch (e) {
    console.error('[claude] parse failed, using fallback', e.message);
    return keywordParse(rawText);
  }
}

module.exports = { parseOrder };
