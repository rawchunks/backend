# Generation

Generate vocal or instrumental music with Fast or Studio Master. Requests support a sound description, lyrics, vocal language, duration, tempo, key and a vocal reference or prepared voice.

This module also handles prompt and lyrics formatting, artwork generation and upload, and generation status. A submitted music job returns identifiers you use to follow progress and retrieve the finished song.

[Generate music](https://docs.rawchunks.space/dev/guides/generate/music) · [Lyrics and controls](https://docs.rawchunks.space/dev/guides/generate/lyrics) · [Voices](https://docs.rawchunks.space/dev/guides/generate/voices) · [Endpoints](https://docs.rawchunks.space/dev/endpoints/generation/generate)

## Source

`router.ts` defines the HTTP routes; `schema.ts` defines music request fields. TypeScript, Fastify and Zod are shared with the [backend](../README.md). This module runs as part of that API.

Build from the backend repository root with `npm run build`. Use the integration guides for request examples and the [payment guide](https://docs.rawchunks.space/dev/guides/payments) for current service fees.
