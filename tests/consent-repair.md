# Consent repair — 11 October 2026

Confirmed: deployed frontend consent requests returned Vercel 404 before reaching the API. Browser SDK initialization ignored the configured API URL. Consent persistence additionally rejected first-time EVM accounts without a Solana counterpart and failed to match existing NULL counterparts.

The frontend now uses `VITE_API_URL`, falling back to `https://api.rawchunks.space`, explicitly binds the consent request's account header, and displays the real API/HTTP error. Vercel's existing SPA now resolves direct page URLs. The API accepts any frontend origin without cookie credentials. Consent initializes an EVM account through the existing profile function and uses a NULL-safe counterpart comparison. Signature/message requirements, address validation, account matching, and stale-pair rejection remain.

Verification: 173 focused tests passed, including regression tests first observed failing for domain routing, first-time EVM consent, NULL-counterpart consent, and linking a counterpart to an existing profile. PostgreSQL tests use disposable in-memory engines; no legal consent was fabricated or written to production. Frontend/backend builds passed. Live preflights passed for app.rawchunks.space, rawchunks.vercel.app, localhost:3001 and an unrelated origin. The live API returns existing consent successfully and rejects an empty signature/message explicitly. Production account/consent counts remained 10/9.

Frontend: commit `edb0c8484093cbebc98f942d3da078fb94c5c2c8`, Vercel production deployment `6998177756`, served from both public domains. Backend: Cloud Build `0cdb8f31-2e30-46c7-9512-cb4c49094e7b`, image digest `sha256:af7e052e6ba7e81af7e165de2bca86b22fa094bfcfdddcdad0e7a586c4ef11bb`, both replicas ready.

User signing remains a user action. No new production consent signature was submitted during verification. The existing Colosseum report and historical server-repair report were preserved.
