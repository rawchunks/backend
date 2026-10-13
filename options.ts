import type { FastifyPluginAsync } from 'fastify';
import { client } from './generation/client.js';

const modes = {
  turbo: { id: 'turbo', label: 'Fast' },
  sft: { id: 'sft', label: 'Detailed' },
  base: { id: 'base', label: 'Flexible' },
};
const tasks = {
  repaint: { id: 'repaint', label: 'Rework', description: 'Change a selected section.' },
  lego: { id: 'lego', label: 'Layer', description: 'Add an instrument alongside the source.' },
  extend: { id: 'extend', label: 'Extend', description: 'Continue the song beyond its ending.' },
  complete: { id: 'complete', label: 'Accompany', description: 'Create accompaniment for the source.' },
  cover: { id: 'cover', label: 'Restyle', description: 'Rework the song in a different style.' },
  extract: { id: 'extract', label: 'Separate', description: 'Separate the recording into tracks.' },
};
const number = (label: string, min: number, max: number, extra: Record<string, unknown> = {}) => ({ label, type: 'number', min, max, ...extra });

export function musicOptions(source: Record<string, any>) {
  if (!Array.isArray(source.models) || !Array.isArray(source.languages) || !Array.isArray(source.keys)) throw new Error('Invalid music options');
  const available = source.models.filter((model: any) => typeof model?.name === 'string' && /^acestep-v15-xl-(turbo|sft|base)$/.test(model.name) && Array.isArray(model.supported_task_types));
  const supported = (task: string) => available.filter((model: any) => model.supported_task_types.includes(task)).map((model: any) => model.name.split('-').at(-1) as keyof typeof modes);
  const generation = supported('text2music').filter((id: string) => id !== 'base');
  if (!generation.length || source.languages.some((language: unknown) => typeof language !== 'string') || source.keys.some((key: unknown) => typeof key !== 'string')) throw new Error('Music options are unavailable');
  const languages = new Intl.DisplayNames(['en'], { type: 'language' });
  const taskModes = Object.fromEntries(Object.keys(tasks).map(task => [task, task === 'extract' ? [] : supported(task === 'extend' ? 'repaint' : task)]));
  return {
    generation: {
      modes: Object.values(modes).filter(mode => generation.some(id => id === mode.id)).map(mode => ({ id: mode.id, label: mode.id === 'turbo' ? 'FAST' : 'STUDIO MASTER' })),
      languages: source.languages.filter((id: string) => id !== 'unknown').map((id: string) => ({ id, label: languages.of(id) })),
      duration: { min: 5, max: 300 },
      parameters: {
        bpm: number('Tempo', 30, 300, { step: 1 }),
        keyScale: { label: 'Key', type: 'select', options: source.keys.map((id: string) => ({ id, label: id })) },
        voiceCoverStrength: number('Voice resemblance', 0, 1, { step: 0.05 }),
      },
    },
    editing: {
      modes: available.map((model: any) => modes[model.name.split('-').at(-1) as keyof typeof modes]),
      tasks: Object.values(tasks).filter(task => task.id === 'extract' || taskModes[task.id].length).map(task => ({ ...task, modes: taskModes[task.id] })),
      repaintModes: [{ id: 'conservative', label: 'Conservative' }, { id: 'balanced', label: 'Balanced' }, { id: 'aggressive', label: 'Aggressive' }],
      stems: ['all', 'vocals', 'drums', 'bass', 'other', 'instrumental'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
      duration: { min: 5, max: 300 },
      parameters: {
        coverStrength: number('Source resemblance', 0, 1, { step: 0.05, tasks: ['cover'] }),
        coverNoiseStrength: number('Source detail', 0, 1, { step: 0.05, tasks: ['cover'] }),
        repaintWavCrossfadeSec: number('Transition length (seconds)', 0, 10, { step: 0.01, tasks: ['repaint', 'extend'] }),
        globalCaption: { label: 'Song description', type: 'text', tasks: ['lego'] },
        trackName: {
          label: 'Instrument',
          type: 'select',
          tasks: ['lego'],
          options: [
            { id: 'guitar', label: 'Guitar' },
            { id: 'synth', label: 'Synth' },
            { id: 'drums', label: 'Drums' },
            { id: 'bass', label: 'Bass' },
            { id: 'keyboard', label: 'Keyboard' },
            { id: 'strings', label: 'Strings' },
            { id: 'percussion', label: 'Percussion' },
            { id: 'brass', label: 'Brass' },
            { id: 'woodwinds', label: 'Woodwinds' },
            { id: 'vocals', label: 'Vocals' },
            { id: 'backing_vocals', label: 'Backing Vocals' },
            { id: 'fx', label: 'FX' },
          ],
        },
        trackClasses: { label: 'Instrument groups (comma separated)', type: 'text', tasks: ['complete'] },
      },
    },
  };
}

export const optionsRouter: FastifyPluginAsync = async app => {
  app.get('/options', async (request, reply) => {
    try { return musicOptions(await client.options()); }
    catch (error) { request.log.error(error); return reply.code(503).send({ error: 'Music options are unavailable' }); }
  });
};
