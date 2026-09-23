import { PGlite } from '@electric-sql/pglite';

export function databaseCause(error: unknown): any {
  let cause: any = error;
  while (cause?.cause) cause = cause.cause;
  return cause;
}

/** In-memory PostgreSQL only; no filesystem persistence, network, or .env access. */
export const postgres = {
  user: undefined as unknown as PGlite,
  song: undefined as unknown as PGlite,
};
export async function initializePostgres() {
  postgres.user = new PGlite(); postgres.song = new PGlite();
  await Promise.all([postgres.user.waitReady, postgres.song.waitReady]);
}
export async function closePostgres() {
  await Promise.all([postgres.user.close(), postgres.song.close()]);
}
export async function clearPostgres() {
  await postgres.user.exec('TRUNCATE public.wallet_pairs, public.users CASCADE');
  await postgres.song.exec('TRUNCATE songs, stems, takes, commits, voices CASCADE');
}
export function sqlTag(database: 'user' | 'song') {
  return async (chunks: TemplateStringsArray, ...values: unknown[]) => {
    const text = chunks.reduce((query, chunk, index) => query + chunk + (index < values.length ? `$${index + 1}` : ''), '');
    return (await postgres[database].query(text, values)).rows;
  };
}
type TransportQuery = PromiseLike<unknown> & { execute: (database?: PGlite) => Promise<unknown> };
export const neonTransport = Object.assign((query: string, values: unknown[], options: { arrayMode?: boolean } = {}) => {
  const execute = async (database = postgres.song) => {
    const result = await database.query(query, values, { rowMode: options.arrayMode ? 'array' : 'object' });
    return { ...result, rowCount: result.affectedRows };
  };
  return { execute, then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => execute().then(resolve, reject) };
}, {
  transaction: async (queries: TransportQuery[]) => postgres.song.transaction(async (database) => {
    const results = [];
    for (const query of queries) results.push(await query.execute(database as unknown as PGlite));
    return results;
  }),
});
export const fixtures = {
  evm: `0x${'a'.repeat(40)}`,
  svm: 'So11111111111111111111111111111111111111112',
  song: { id: 'song-a', title: 'Fixture', creator: `0x${'a'.repeat(40)}`, url: 'https://fixture.invalid/audio.wav', duration: 120 },
  stem: { id: 'stem-a', song_id: 'song-a', name: 'vocals', url: 'https://fixture.invalid/vocals.wav' },
  take: { id: 'take-a', song_id: 'song-a', stem_id: 'stem-a', model: 'fixture-model', task: 'repaint', url: 'https://fixture.invalid/take.wav', is_active: true },
};
