// Vercel serverless function: GET /api/prompt — returns the prompt template.
const { loadPromptTemplate } = require('../lib/coach');

module.exports = (req, res) => {
  try {
    res.status(200).json({ template: loadPromptTemplate() });
  } catch (err) {
    res.status(500).json({ template: '', error: String(err.message || err) });
  }
};
