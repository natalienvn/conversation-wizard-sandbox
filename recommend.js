// Vercel serverless function: POST /api/recommend
const { recommend } = require('../lib/coach');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const payload = typeof req.body === 'object' && req.body ? req.body : {};
  const { status, body } = await recommend(payload);
  res.status(status).json(body);
};
