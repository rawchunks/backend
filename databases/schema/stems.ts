import { pgTable, text, real, boolean, timestamp, index, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { songs } from './songs.js';

export const stems = pgTable('stems', {
  id: text('id').primaryKey(),
  song_id: text('song_id').notNull().references(() => songs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // 'vocals' | 'drums' | 'bass' | 'synth' | 'backing_vocals' | 'other' | 'master'
  url: text('url').notNull(), // Audio file URL in storage
  waveform_peaks_url: text('waveform_peaks_url'), // Pre-calculated JSON peaks URL for instant UI rendering
  volume: real('volume').default(1.0).notNull(), // 0.0 to 1.0 (or >1.0 for gain boost)
  pan: real('pan').default(0.0).notNull(), // -1.0 (L) to +1.0 (R)
  is_muted: boolean('is_muted').default(false).notNull(),
  is_solo: boolean('is_solo').default(false).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('stems_song_id_id_unique').on(table.song_id, table.id),
  index('stems_song_idx').on(table.song_id),
  check('stems_mixer_check', sql`${table.volume} >= 0 and ${table.volume} < 'Infinity'::real and ${table.pan} between -1 and 1`),
]);

export type Stem = typeof stems.$inferSelect;
export type NewStem = typeof stems.$inferInsert;
