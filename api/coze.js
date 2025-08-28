// api/coze.js
const crypto = require('crypto');

const COZE_API_BASE = 'https://api.coze.com';
const COZE_CHAT_PATH = '/open_api/v2/chat';

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function setCors(res, reqOrigin) {
  const allowed = getAllowedOrigins();
  const origin =
    allowed.length === 0
      ? '*'
      : (reqOrigin && allowed.includes(reqOrigin) ? reqOrigin : allowed[0]);

  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Auth, X-COZE-Path');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function verifyAppAuth(req) {
  const secret = process.env.APP_SHARED_SECRET;
  if (!secret) return true;       // 未设置共享密钥则跳过
  const hdr = req.headers['x-app-auth'];
  if (!hdr) return false;
  return crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(secret));
}

module.exports = async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  if (!verifyAppAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  let payload = {};
  try {
    payload = req.body || {};
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // 仅放行白名单字段，避免直通任意参数
  const allowKeys = new Set(['conversation_id', 'query', 'meta', 'stream', 'user_id']);
  const safeBody = {};
  for (const k of Object.keys(payload)) if (allowKeys.has(k)) safeBody[k] = payload[k];

  const cozePathHeader = (req.headers['x-coze-path'] || '').trim();
  const targetPath = cozePathHeader.startsWith('/open_api/') ? cozePathHeader : COZE_CHAT_PATH;
  const apiKey = process.env.COZE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'COZE_API_KEY is not configured' });

  try {
    const upstream = await fetch(`https://api.coze.com${targetPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(safeBody),
    });

    res.status(upstream.status);

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }

    const text = await upstream.text();
    res.setHeader('Content-Type', contentType || 'application/json; charset=utf-8');
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream fetch failed', detail: String(e.message || e) });
  }
};
