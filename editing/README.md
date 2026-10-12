# Editing

Edit existing audio with Rework, Layer, Extract, Separate, Extend and Restyle. Each operation produces a candidate you can preview before choosing what to keep.

The API also supports uploaded source and arrangement audio, take activation, saved timeline snapshots and edit history. Your own player or editor controls how users hear and arrange the returned audio.

[Editing guide](https://docs.rawchunks.space/dev/guides/edit/overview) · [Takes](https://docs.rawchunks.space/dev/guides/edit/takes) · [Render and merge](https://docs.rawchunks.space/dev/guides/edit/merge) · [Endpoints](https://docs.rawchunks.space/dev/endpoints/editing/apply)

## Source

`router.ts` defines requests and validation; `audio.ts` handles audio inputs. Built with TypeScript, Fastify and Zod as part of the [backend](../README.md).

Build from the backend repository root with `npm run build`. The endpoint reference preserves HTTP route names where they differ from the app's operation labels.
