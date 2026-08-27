// Owner: Intake (A). Turns a messy free-text SMS into a structured order.
// This is the honest "interpret messy information" step of the agent.
// Falls back to a keyword parser when no OPENROUTER_API_KEY is set, so the
// pipeline works offline during early development.

const cfg = require('./config');

function keywordParse(text) {
  const items = [];
  // Split on the joins people actually type, so "3 doors and 2 gates" does not
  // collapse into one item called "doors and 2 gates".
  const parts = String(text).split(/\s+and\s+|\s+plus\s+|[,;]|then/i);
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
  if (!cfg.llm.apiKey) return keywordParse(rawText);

  try {
    const response = await fetch(`${cfg.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.llm.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': cfg.publicBaseUrl,
        'X-Title': cfg.businessName,
      },
      body: JSON.stringify({
        model: cfg.llm.model,
        max_tokens: 400,
        messages: [{ role: 'user', content: `Customer SMS: "${rawText}"` }],
        tools: [{
          type: 'function',
          function: {
            name: 'record_order',
            description: 'Extract a manufacturing order from a customer message.',
            parameters: {
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
          },
        }],
        tool_choice: { type: 'function', function: { name: 'record_order' } },
      }),
    });

    if (!response.ok) {
      console.error(`[claude] API error: ${response.status} ${response.statusText}`);
      return keywordParse(rawText);
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      console.error('[claude] no tool call in response');
      return keywordParse(rawText);
    }

    const parsed = JSON.parse(toolCall.function.arguments);
    if (Array.isArray(parsed.items) && parsed.items.length) {
      return parsed;
    }
    return keywordParse(rawText);
  } catch (e) {
    console.error('[claude] parse failed, using fallback', e.message);
    return keywordParse(rawText);
  }
}

module.exports = { parseOrder };
