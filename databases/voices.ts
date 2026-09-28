import { eq, desc, inArray, and, isNull, notInArray, sql } from 'drizzle-orm';
import { songDb } from './client.js';
import { voices, voiceAdapters, type Voice, type NewVoice, type VoiceAdapter, type NewVoiceAdapter } from './schema/voices.js';
const owner = (address: string) => /^0x/i.test(address) ? address.toLowerCase() : address;

export async function createVoice(data: NewVoice): Promise<Voice> {
  return (await songDb.insert(voices).values({ ...data, creator: owner(data.creator) }).returning())[0];
}
export async function getVoiceById(id: string): Promise<Voice | null> {
  return (await songDb.select().from(voices).where(eq(voices.id, id)).limit(1))[0] ?? null;
}
export async function getCanonicalVoice(id: string): Promise<Voice | null> {
  const seen = new Set<string>(); let original: Voice | null = null;
  while (!seen.has(id)) {
    seen.add(id); const voice = await getVoiceById(id);
    if (!voice || (original && voice.creator !== original.creator)) return null;
    original ??= voice;
    if (!voice.canonical_id) return voice;
    id = voice.canonical_id;
  }
  throw new Error('Voice canonical links contain a cycle');
}
export async function findVoiceByHash(creator: string, hash: string): Promise<Voice | null> {
  return (await songDb.select().from(voices).where(and(eq(voices.creator, owner(creator)), eq(voices.hash, hash), isNull(voices.canonical_id))).limit(1))[0] ?? null;
}
/** Binary registrations share an owner/hash row; recipe aliases retain their committed ID. */
export async function createVoiceDeduplicated(data: NewVoice): Promise<Voice> {
  if (!data.hash) return createVoice(data);
  const values = { ...data, creator: owner(data.creator) };
  const committed = async () => {
    const found = data.canonical_id ? await getVoiceById(data.id) : await findVoiceByHash(values.creator, data.hash!);
    if (found && data.canonical_id && (found.creator !== values.creator || found.canonical_id !== data.canonical_id || found.hash !== data.hash)) throw new Error('Voice alias registration identity mismatch');
    return found;
  };
  try {
    const result = await songDb.insert(voices).values(values).onConflictDoNothing().returning();
    if (result[0]) return result[0];
  } catch (error) {
    const saved = await committed().catch(() => null);
    if (saved) return saved;
    throw error;
  }
  const canonical = await committed();
  if (!canonical) throw new Error('Voice duplicate registration has no canonical sample');
  return canonical;
}
export async function findVoiceBySource(creator: string, songId: string, sourceUrl: string): Promise<Voice | null> {
  return (await songDb.select().from(voices).where(and(eq(voices.creator, owner(creator)), eq(voices.source_song_id, songId), sql`${voices.metadata}->>'source_url' = ${sourceUrl}`)).orderBy(voices.created_at, voices.id).limit(1))[0] ?? null;
}
export async function createVoiceFromSource(data: NewVoice): Promise<Voice> {
  if (!data.source_song_id || typeof data.metadata?.source_url !== 'string') throw new Error('Voice source identity is required');
  const existing = await findVoiceBySource(data.creator, data.source_song_id, data.metadata.source_url);
  if (existing) return existing;
  try {
    const result = await songDb.insert(voices).values({ ...data, creator: owner(data.creator) }).onConflictDoNothing().returning();
    if (result[0]) return result[0];
  } catch (error) {
    const committed = await findVoiceBySource(data.creator, data.source_song_id, data.metadata.source_url).catch(() => null);
    if (committed) return committed;
    throw error;
  }
  const committed = await findVoiceBySource(data.creator, data.source_song_id, data.metadata.source_url);
  if (!committed) throw new Error('Source recording registration has no persisted receipt');
  return committed;
}
export async function listVoicesByCreator(creatorAddress: string): Promise<Voice[]> {
  return songDb.select().from(voices).where(eq(voices.creator, owner(creatorAddress))).orderBy(desc(voices.created_at));
}
export async function listPendingVoices(limit = 20, statuses?: Voice['status'][]): Promise<Voice[]> {
  return songDb.select().from(voices).where(statuses ? inArray(voices.status, statuses) : notInArray(voices.status, ['ready', 'error'])).orderBy(sql`${voices.metadata}->>'reconciled_at' asc nulls first`, voices.created_at).limit(limit);
}
export async function listVoiceInventory(): Promise<Voice[]> { return songDb.select().from(voices).orderBy(voices.created_at); }
export async function updateVoice(id: string, updates: Partial<NewVoice>): Promise<Voice | null> {
  if (['id', 'creator', 'created_at'].some(key => key in updates)) throw new Error('Voice identity and ownership cannot be updated');
  return (await songDb.update(voices).set(updates).where(eq(voices.id, id)).returning())[0] ?? null;
}
/** Caller holds the owner/hash lease; older IDs remain same-owner canonical links. */
export async function consolidateVoiceSample(id: string, updates: Pick<NewVoice, 'hash' | 'sample_url' | 'training_group' | 'metadata'>): Promise<Voice | null> {
  const current = await getVoiceById(id); if (!current || !updates.hash) return null;
  const canonical = await findVoiceByHash(current.creator, updates.hash);
  if (canonical && canonical.id !== id) {
    await updateVoice(id, { ...updates, canonical_id: canonical.id, training_group: canonical.training_group, status: 'saved', task_id: null, error: null });
    return canonical;
  }
  return updateVoice(id, { ...updates, canonical_id: null, ...(!current.hash ? { status: 'saved' as const, error: null } : {}) });
}
export async function listAdaptersByGroup(group: string): Promise<VoiceAdapter[]> {
  return songDb.select().from(voiceAdapters).where(eq(voiceAdapters.training_group, group)).orderBy(desc(voiceAdapters.created_at));
}
export async function createVoiceAdapter(data: NewVoiceAdapter): Promise<VoiceAdapter> {
  try {
    const rows = await songDb.insert(voiceAdapters).values(data).onConflictDoNothing().returning(); if (rows[0]) return rows[0];
  } catch (error) {
    const found = (await listAdaptersByGroup(data.training_group).catch(() => [])).find(a => a.model === data.model && a.checkpoint_fingerprint === data.checkpoint_fingerprint && a.settings_digest === data.settings_digest);
    if (found) return found;
    throw error;
  }
  const result = (await listAdaptersByGroup(data.training_group)).find(a => a.model === data.model && a.checkpoint_fingerprint === data.checkpoint_fingerprint && a.settings_digest === data.settings_digest);
  if (!result) throw new Error('Adapter duplicate has no persisted identity'); return result;
}
export async function updateVoiceAdapter(id: string, updates: Partial<NewVoiceAdapter>): Promise<VoiceAdapter | null> {
  if (['id','training_group','model','checkpoint_fingerprint','settings_digest','settings','task_id','created_at'].some(key => key in updates)) throw new Error('Adapter training identity cannot be updated');
  return (await songDb.update(voiceAdapters).set({ ...updates, updated_at: new Date() }).where(eq(voiceAdapters.id, id)).returning())[0] ?? null;
}
