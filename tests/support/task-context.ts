export const contexts = new Map<string, any>();
const locks = new Map<string, Promise<unknown>>();

export function resetContexts() {
  contexts.clear();
  locks.clear();
}

export const broker = {
  async setTaskContext(id: string, value: unknown) {
    contexts.set(id, structuredClone(value));
  },
  async getTaskContext(id: string) {
    const value = contexts.get(id);
    return value ? structuredClone(value) : null;
  },
  async withJobLock<T>(key: string, fn: (assertLease: () => Promise<void>) => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => fn(Object.assign(async () => {}, { save: broker.setTaskContext })));
    locks.set(key, current);
    try { return await current; }
    finally { if (locks.get(key) === current) locks.delete(key); }
  },
};

export function generationContext(taskId = 'task-1', songId = 'song-1', extras = {}) {
  contexts.set(taskId, { kind: 'generate', songId, creator: 'creator', prompt: 'a soulful song', lyrics: 'lyrics', model: 'acestep-v15-xl-turbo', ...extras });
}

export function editContext(taskId = 'task-1', params = {}) {
  contexts.set(taskId, { kind: 'edit', params: { songId: 'song-1', userAddress: '0xABCDEF0123', task: 'cover', prompt: 'new style', ...params }, model: 'acestep-v15-xl-base' });
}
