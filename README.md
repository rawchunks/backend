# Rawchunks API

The API behind the Rawchunks app and third-party music integrations. It provides music generation, audio edits, reusable voices, artwork, songs, albums, takes and project history.

[Developer overview](https://docs.rawchunks.space/dev/overview) · [Endpoint reference](https://docs.rawchunks.space/dev/endpoints/overview) · [Integration guides](https://docs.rawchunks.space/dev/guides/connect)

## Modules

| Module | Scope |
| --- | --- |
| [generation](generation/README.md) | Fast and Studio Master generation, lyrics controls, artwork and job status. |
| [editing](editing/README.md) | Section edits, layers, stems, takes, arrangement audio and history. |
| [databases](databases/README.md) | Songs, users, albums, voices and saved project records. |
| voice | Vocal references and trained voice preparation. |

Built with TypeScript, Fastify and Zod, with PostgreSQL and Drizzle for project data.

## Call the API

Use `https://api.rawchunks.space`. Create a Rawchunks **SESSION** and use its complete token for paid calls. The [request setup guide](https://docs.rawchunks.space/dev/guides/connect) gives the headers and a reusable request helper; [job handling](https://docs.rawchunks.space/dev/guides/jobs) covers progress and results.

Minting and license purchases use the [blockchain interfaces](https://github.com/rawchunks/blockchain) with a wallet.

## Work on the source

Run from this repository:

```sh
npm ci
npm run build
```

`npm run dev` starts the configured API. It requires local service and database configuration. See [tests](tests/README.md) for checks that use local fixtures and provider substitutes.
