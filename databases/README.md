# Project data

Store and retrieve the records that let a music project continue across sessions: users, songs, stems, takes, albums, saved voices and history snapshots.

Song records link audio, artwork, selling terms and any recorded chain song ID. A chain ID links a catalog record to a song onchain; transaction confirmation remains part of the wallet workflow.

[Library integration](https://docs.rawchunks.space/dev/guides/library) · [Project endpoints](https://docs.rawchunks.space/dev/endpoints/overview)

## Source

PostgreSQL schemas and Drizzle queries live here. `schema/` defines the records; `router.ts` exposes project routes through the [backend](../README.md). This is a backend module, not a standalone service.

Build from the backend repository root with `npm run build`. The [backend tests](../tests/README.md) cover queries and migrations in disposable local databases.
