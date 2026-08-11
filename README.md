# Conversation Wizard Sandbox

Conversational test UI for the care-coaching recommendation prompt. Runs on the Claude API (Anthropic).

## Deploy on Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: Add New -> Project -> Import the repo (no settings changes needed).
3. In the project's Settings -> Environment Variables, add:
   ANTHROPIC_API_KEY = your key from https://platform.claude.com/settings/keys
4. Redeploy. Done.

Without the key, the "mock (no API)" model still works for UI testing.

## Run locally

    npm install
    ANTHROPIC_API_KEY=sk-ant-... npm start

Then open http://localhost:4477.

## Files

- public/index.html - the whole UI
- api/recommend.js, api/agent-chat.js, api/prompt.js - serverless API routes
- lib/coach.js - Claude API calls + mock model
- prompt.txt - the recommendation prompt (edit this to change the wizard's behavior)
- server.js - local dev server (not used on Vercel)
