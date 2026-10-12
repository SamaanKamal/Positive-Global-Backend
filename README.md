# Backend — Positive Global Travel

The original `server/server.js` and `server/config.js` are preserved **unchanged**. This project has its own `package.json`, `package-lock.json`, and `.gitignore`.

## Start

Use Node.js >=20. Run `npm install` followed by `npm start` inside this backend directory. The API runs at http://localhost:3000 and the health endpoint is http://localhost:3000/api/health.

The frontend must be run separately at http://localhost:3001 using its included `server.py`.

## Recommended manual JavaScript changes (not applied)

`server/server.js` still contains the original static-files setup. For a fully API-only backend, remove its `PUBLIC_DIR` constant, `app.use(express.static(PUBLIC_DIR));`, and replace the website 404 `sendFile(...)` middleware with a JSON 404 response. Details are in the root `SEPARATION_GUIDE.md`.

**Security:** `server/config.js` contains a hardcoded Duffel test token. Treat it as a credential; rotate it if this archive or repository was exposed and move it into `process.env.DUFFEL_ACCESS_TOKEN` before publication. Never move the token into the frontend.
