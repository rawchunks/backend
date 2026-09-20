import { pgTable, text, timestamp, index, uniqueIndex, check, jsonb, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const voices = pgTable('voices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  creator: text('creator').notNull(),
  sample_url: text('sample_url'),
  hash: text('hash'),
  source_song_id: text('source_song_id'),
  canonical_id: text('canonical_id'),
  task_id: text('task_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  training_group: text('training_group').notNull(),
  status: text('status').$type<'saved' | 'extracting' | 'queued' | 'training' | 'ready' | 'error'>().default('saved').notNull(),
  error: text('error'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('voices_creator_created_idx').on(table.creator, table.created_at.desc()),
  index('voices_pending_idx').on(table.status).where(sql`${table.canonical_id} is null and ${table.status} not in ('ready', 'error')`),
  uniqueIndex('voices_owner_hash_idx').on(table.creator, table.hash).where(sql`${table.canonical_id} is null and ${table.hash} is not null`),
  uniqueIndex('voices_id_creator_idx').on(table.id, table.creator),
  foreignKey({ name: 'voices_canonical_owner_fk', columns: [table.canonical_id, table.creator], foreignColumns: [table.id, table.creator] }),
  check('voices_status_check', sql`${table.status} in ('saved', 'extracting', 'queued', 'training', 'ready', 'error')`),
  check('voices_hash_check', sql`${table.hash} is null or ${table.hash} ~ '^[a-f0-9]{64}$'`),
  check('voices_alias_check', sql`${table.canonical_id} is null or ${table.canonical_id} <> ${table.id}`),
]);

export const voiceAdapters = pgTable('voice_adapters', {
  id: text('id').primaryKey(),
  training_group: text('training_group').notNull(),
  model: text('model').notNull(),
  checkpoint_fingerprint: text('checkpoint_fingerprint').notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
  settings_digest: text('settings_digest').notNull(),
  task_id: text('task_id').notNull(),
  status: text('status').$type<'queued' | 'training' | 'ready' | 'error'>().default('queued').notNull(),
  artifact_url: text('artifact_url'),
  artifact_digest: text('artifact_digest'),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().default({}).notNull(),
  error: text('error'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('voice_adapters_identity_idx').on(table.training_group, table.model, table.checkpoint_fingerprint, table.settings_digest),
  uniqueIndex('voice_adapters_task_idx').on(table.task_id),
  index('voice_adapters_group_idx').on(table.training_group),
  check('voice_adapters_status_check', sql`${table.status} in ('queued', 'training', 'ready', 'error')`),
  check('voice_adapters_digest_check', sql`${table.settings_digest} ~ '^[a-f0-9]{64}$' and (${table.artifact_digest} is null or ${table.artifact_digest} ~ '^[a-f0-9]{64}$')`),
  check('voice_adapters_ready_check', sql`${table.status} <> 'ready' or (${table.artifact_url} is not null and length(trim(${table.artifact_url})) > 0 and ${table.artifact_digest} is not null)`),
]);
export type Voice = typeof voices.$inferSelect;
export type NewVoice = typeof voices.$inferInsert;
export type VoiceAdapter = typeof voiceAdapters.$inferSelect;
export type NewVoiceAdapter = typeof voiceAdapters.$inferInsert;
