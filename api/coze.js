// api/coze.js
const crypto = require('crypto');

const DEFAULT_COZE_BASE = process.env.COZE_BASE_URL || 'https://api.coze.cn';
const DEBUG = (req) => String(req.headers['x-debug'] || '') === '1';

function allowOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}
function setCors(res, origin) {
  const allow = allowOrigins();
  const o = allow.length ? (origin && allow.includes(origin) ? origin : allow[0]) : '*';
  res.setHeader('Access-Control-Allow-Origin', o || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Auth, X-Debug');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function verifyShared(req) {
  const secret = process.env.APP_SHARED_SECRET;
  if (!secret) return true;
  const hdr = req.headers['x-app-auth'];
  if (!hdr) return false;
  const a = Buffer.from(String(hdr));
  const b = Buffer.from(String(secret));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  setCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!verifyShared(req)) return res.status(401).json({ error: 'Unauthorized' });

  let body = {};
  try { body = req.body || {}; } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const { bot_id, user_id, additional_messages, conversation_id, stream = true } = body;
  if (!bot_id || !user_id || !Array.isArray(additional_messages)) {
    return res.status(400).json({ error: 'Missing fields: bot_id, user_id, additional_messages[]' });
  }
  const token = process.env.COZE_API_KEY;
  if (!token) return res.status(500).json({ error: 'COZE_API_KEY is not configured' });

  // 动态导入官方 SDK（ESM 包）
  let CozeAPI;
  try {
    ({ CozeAPI } = await import('@coze/api'));
  } catch (e) {
    const msg = 'Failed to import @coze/api';
    if (DEBUG(req)) return res.status(500).json({ error: msg, detail: String(e?.stack || e) });
    return res.status(500).json({ error: msg });
  }

  const api = new CozeAPI({ token, baseURL: DEFAULT_COZE_BASE });

  try {
    if (stream) {
      const s = await api.chat.stream({
        bot_id,
        user_id,
        additional_messages,
        ...(conversation_id ? { conversation_id } : {})
      });

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      // 1) AsyncIterable
      if (s && typeof s[Symbol.asyncIterator] === 'function') {
        for await (const chunk of s) {
          if (DEBUG(req)) console.log('[coze-chunk-iterable]', chunk);
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n'); return res.end();
      }

      // 2) Web ReadableStream
      if (s && typeof s.getReader === 'function') {
        const reader = s.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = Buffer.isBuffer(value) ? value.toString('utf-8')
                     : value?.constructor?.name === 'Uint8Array' ? Buffer.from(value).toString('utf-8')
                     : typeof value === 'string' ? value
                     : '';
          if (DEBUG(req)) console.log('[coze-chunk-reader]', text);
          // SDK若已经是JSON片段，就直接包data:；否则原样透传
          res.write(`data: ${text}\n\n`);
        }
        res.write('data: [DONE]\n\n'); return res.end();
      }

      // 3) 兜底：不认识的结构
      if (DEBUG(req)) console.log('[coze-unknown-stream]', typeof s, Object.keys(s||{}));
      res.write(`data: ${JSON.stringify({ notice: 'unknown stream payload' })}\n\n`);
      res.write('data: [DONE]\n\n'); return res.end();
    }

    // 非流式：把增量收集后一次性返回，便于排错
    const s = await api.chat.stream({
      bot_id, user_id, additional_messages, ...(conversation_id ? { conversation_id } : {})
    });
    const chunks = [];

    if (s && typeof s[Symbol.asyncIterator] === 'function') {
      for await (const c of s) chunks.push(c);
    } else if (s && typeof s.getReader === 'function') {
      const reader = s.getReader(); const decoder = new TextDecoder(); let buf = '';
      while (true) { const { done, value } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true }); }
      chunks.push({ raw: buf });
    } else {
      chunks.push({ notice: 'unknown non-stream payload' });
    }
    return res.status(200).json({ ok: true, chunks });

  } catch (e) {
    const payload = { error: 'Coze API call failed', detail: String(e?.message || e) };
    if (DEBUG(req)) payload.stack = String(e?.stack || '');
    return res.status(502).json(payload);
  }
};
