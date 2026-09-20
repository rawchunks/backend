import { pgTable, text, timestamp, jsonb, index, unique, foreignKey } from 'drizzle-orm/pg-core';
import { songs } from './songs.js';

export const commits = pgTable('commits', {
  id: text('id').primaryKey(),
  song_id: text('song_id').notNull().references(() => songs.id, { onDelete: 'cascade' }),
  user_address: text('user_address').notNull(),
  parent_commit_id: text('parent_commit_id'),
  message: text('message').notNull(),
  timeline_snapshot: jsonb('timeline_snapshot').notNull(), // Full JSON serialization of tracks, stems, active takes, and mixer state
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('commits_song_id_id_unique').on(table.song_id, table.id),
  index('commits_song_created_idx').on(table.song_id, table.created_at.desc()),
  foreignKey({ name: 'commits_song_parent_fk', columns: [table.song_id, table.parent_commit_id], foreignColumns: [table.song_id, table.id] }),
]);

export type Commit = typeof commits.$inferSelect;
export type NewCommit = typeof commits.$inferInsert;
