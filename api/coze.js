// api/coze.js
const crypto = require('crypto');

// 你也可以通过环境变量切换到 https://api.coze.com
const DEFAULT_COZE_BASE = process.env.COZE_BASE_URL || 'https://api.coze.cn';

const DEBUG = (req) => String(req.headers['x-debug'] || '') === '1';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Auth');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function verifyAppAuth(req) {
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
  if (!verifyAppAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  // 解析输入
  let body = {};
  try {
    body = req.body || {};
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const {
    bot_id,
    user_id,
    additional_messages,
    conversation_id, // 可选
    // 允许前端传 stream=true/false；不传默认走流式
    stream = true
  } = body;

  if (!bot_id || !user_id || !Array.isArray(additional_messages)) {
    return res.status(400).json({
      error: 'Missing required fields: bot_id, user_id, additional_messages[]'
    });
  }

  const token = process.env.COZE_API_KEY;
  if (!token) return res.status(500).json({ error: 'COZE_API_KEY is not configured' });

  const baseURL = DEFAULT_COZE_BASE; // 也可从 req.headers['x-coze-base'] 读取覆盖

  // 动态导入官方 SDK（其包为 ESM，CJS 里用 dynamic import 最稳妥）
  const { CozeAPI } = await import('@coze/api');

  const api = new CozeAPI({
    token,
    baseURL // 例：'https://api.coze.cn' 或 'https://api.coze.com'
  });

  try {
    if (stream) {
      // ====== 流式：把 SDK 的流逐段写成 SSE ======
      const s = await api.chat.stream({
        bot_id,
        user_id,
        additional_messages,
        // SDK 是否支持传 conversation_id：如支持可按需带上
        ...(conversation_id ? { conversation_id } : {})
      });

      // 设置 SSE 响应头
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      // 情况1：SDK 返回 AsyncIterable
      if (s && typeof s[Symbol.asyncIterator] === 'function') {
        for await (const chunk of s) {
          // 直接把每个事件对象包装为 SSE
          if (DEBUG(req)) console.log('[coze-chunk]', chunk);
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write(`data: [DONE]\n\n`);
        return res.end();
      }

      // 情况2：SDK 返回 Web ReadableStream
      if (s && s.getReader) {
        const reader = s.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // 假设 value 是 Uint8Array 或字符串
          const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf-8');
          // 如果 SDK 已经产出了 SSE 格式，也可以直接写入；这里稳妥起见包一层 data:
          if (DEBUG(req)) console.log('[coze-chunk-text]', text);
          res.write(`data: ${text}\n\n`);
        }
        res.write(`data: [DONE]\n\n`);
        return res.end();
      }

      // 情况3：无法识别的返回（兜底）
      res.write(`data: ${JSON.stringify({ notice: 'unknown stream payload' })}\n\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    } else {
      // ====== 非流式（同步拿完整结果）======
      // 如果 SDK 有非流式方法（如 api.chat.create），你可以替换为相应方法
      const s = await api.chat.stream({
        bot_id,
        user_id,
        additional_messages,
        ...(conversation_id ? { conversation_id } : {})
      });

      // 收集完整输出返回 JSON（作为兜底兼容）
      const chunks = [];
      if (s && typeof s[Symbol.asyncIterator] === 'function') {
        for await (const chunk of s) chunks.push(chunk);
      } else if (s && s.getReader) {
        const reader = s.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
        }
        chunks.push({ raw: buf });
      }
      return res.status(200).json({ ok: true, chunks });
    }
  } catch (e) {
    // 上游/SDK 抛错
    return res.status(502).json({
      error: 'Coze API call failed',
      detail: String(e?.message || e)
    });
  }
};
