// api/hello.js
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.json({ ok: true, time: new Date().toISOString() });
};
