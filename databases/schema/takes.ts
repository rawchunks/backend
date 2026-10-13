import { pgTable, text, integer, real, boolean, timestamp, bigint, jsonb, index, uniqueIndex, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { songs } from './songs.js';
import { stems } from './stems.js';

export interface AlignedWord {
  text: string;
  start: number;
  end: number;
  loss?: number;
}

export interface AlignedLine {
  index: number;
  text: string;
  isTag?: boolean;
  start: number | null;
  end: number | null;
  words: AlignedWord[];
}

export interface LyricsAlignment {
  source: 'scribe_v2' | 'forced_alignment';
  updatedAt: string;
  lines: AlignedLine[];
  words: AlignedWord[];
}

export interface TakeProvenance {
  taskId: string;
  sourceUrl: string;
  sourceTakeId: string | null;
  sourceDuration: number | null;
  target: 'master' | 'stem' | 'layer';
  targetStemId: string | null;
  layerName?: string;
  region: { start: number; end: number } | null;
  outputDuration: number | null;
  audioOffset?: number;
  regions?: { start: number; end: number }[];
  mergedInto?: string;
  candidates?: string[];
  original?: boolean;
  parameters: Record<string, unknown>;
}

export const takes = pgTable('takes', {
  id: text('id').primaryKey(),
  song_id: text('song_id').notNull().references(() => songs.id, { onDelete: 'cascade' }),
  stem_id: text('stem_id').references(() => stems.id, { onDelete: 'set null' }),
  take_number: integer('take_number').default(1).notNull(),
  model: text('model').notNull(), // 'acestep-v15-xl-turbo' | 'acestep-v15-xl-sft' | 'acestep-v15-xl-base'
  task: text('task').notNull(), // 'text2music' | 'repaint' | 'lego' | 'complete' | 'cover' | 'extract'
  prompt: text('prompt'),
  lyrics: text('lyrics'),
  repainting_start: real('repainting_start'), // in seconds
  repainting_end: real('repainting_end'),     // in seconds
  url: text('url').notNull(), // Audio clip file URL
  waveform_url: text('waveform_url'),
  is_active: boolean('is_active').default(false).notNull(), // Whether this take is currently selected in the DAW comp
  seed: bigint('seed', { mode: 'number' }),
  provenance: jsonb('provenance').$type<TakeProvenance>(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('takes_song_stem_idx').on(table.song_id, table.stem_id),
  uniqueIndex('takes_active_stem_idx').on(table.song_id, table.stem_id).where(sql`${table.is_active} and ${table.stem_id} is not null`),
  uniqueIndex('takes_active_master_idx').on(table.song_id).where(sql`${table.is_active} and ${table.stem_id} is null`),
  foreignKey({ name: 'takes_song_stem_fk', columns: [table.song_id, table.stem_id], foreignColumns: [stems.song_id, stems.id] }),
  check('takes_values_check', sql`${table.take_number} > 0 and (${table.repainting_start} is null or (${table.repainting_start} >= 0 and ${table.repainting_start} < 'Infinity'::real)) and (${table.repainting_end} is null or (${table.repainting_end} >= 0 and ${table.repainting_end} < 'Infinity'::real)) and (${table.repainting_start} is null or ${table.repainting_end} is null or ${table.repainting_end} >= ${table.repainting_start})`),
]);

export type Take = typeof takes.$inferSelect;
export type NewTake = typeof takes.$inferInsert;
