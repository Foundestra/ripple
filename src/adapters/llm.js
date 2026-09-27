// Optional LLM provider for the specialist agents. Ripple works fully without
// one (deterministic heuristics); with a key, agents add model-written
// judgement on top. Every call has a timeout and falls back on failure, so a
// flaky network never breaks a demo or a PR comment.

export function createLlm(config) {
  const c = config.llm;
  if (c.provider === 'gemini' && c.geminiKey) return new GeminiLlm(c);
  if (c.provider === 'anthropic' && c.anthropicKey) return new AnthropicLlm(c);
  return new NoLlm();
}

class NoLlm {
  name = 'none';
  enabled = false;
  async json() {
    return null;
  }
}

class GeminiLlm {
  name = 'gemini';
  enabled = true;
  constructor(c) {
    this.key = c.geminiKey;
    this.model = c.geminiModel;
    this.timeoutMs = c.timeoutMs;
  }

  async json(system, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    return parseJson(text);
  }
}

class AnthropicLlm {
  name = 'anthropic';
  enabled = true;
  constructor(c) {
    this.key = c.anthropicKey;
    this.model = c.anthropicModel;
    this.timeoutMs = c.timeoutMs;
  }

  async json(system, prompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 800,
        system: system + '\nRespond with a single JSON object and nothing else.',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    return parseJson(body.content?.map((b) => b.text || '').join('') ?? '');
  }
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}
