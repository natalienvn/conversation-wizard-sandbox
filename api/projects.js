// Vercel serverless function: GET /api/projects — list the built-in projects
// (one file per project in prompts/).
const { loadProjects } = require('../lib/coach');

module.exports = (req, res) => {
  try {
    res.status(200).json({ projects: loadProjects() });
  } catch (err) {
    res.status(500).json({ projects: [], error: String(err.message || err) });
  }
};
