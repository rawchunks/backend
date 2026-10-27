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
  extract: { id: 'extract', label: 'Extract', description: 'Extract the recording into tracks.' },
};
const number = (label: string, min: number, max: number, extra: Record<string, unknown> = {}) => ({ label, type: 'number', min, max, ...extra });

export const TRACK_OPTIONS = [
  { id: 'vocals', label: 'Vocals' },
  { id: 'backing_vocals', label: 'Backing Vocals' },
  { id: 'drums', label: 'Drums' },
  { id: 'bass', label: 'Bass' },
  { id: 'guitar', label: 'Guitar' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'percussion', label: 'Percussion' },
  { id: 'strings', label: 'Strings' },
  { id: 'synth', label: 'Synth' },
  { id: 'fx', label: 'FX' },
  { id: 'brass', label: 'Brass' },
  { id: 'woodwinds', label: 'Woodwinds' },
];

export const REWORK_PRESETS = [
  { id: 'subtle', mode: 'conservative' as const, strength: 0, label: 'Subtle (0%)', shortLabel: 'Subtle', desc: 'Preserves original melody, timing & structure closely' },
  { id: 'light', mode: 'balanced' as const, strength: 0.25, label: 'Light (25%)', shortLabel: 'Light', desc: 'Gentle timbral & phrasing variation while locking groove' },
  { id: 'balanced', mode: 'balanced' as const, strength: 0.5, label: 'Balanced (50%)', shortLabel: 'Balanced', desc: 'Blends original musical phrasing with fresh AI variation' },
  { id: 'strong', mode: 'balanced' as const, strength: 0.75, label: 'Strong (75%)', shortLabel: 'Strong', desc: 'Major creative rework with loose structural anchoring' },
  { id: 'bold', mode: 'aggressive' as const, strength: 1.0, label: 'Bold (100%)', shortLabel: 'Bold', desc: 'Reimagines the selected region freely from your prompt' },
];

export const COVER_PRESETS = [
  { id: '0.35', value: 0.35, strength: 0.35, noise: 0.05, label: 'Subtle (35%)', shortLabel: 'Subtle', desc: 'Light timbral restyling while keeping original groove' },
  { id: '0.65', value: 0.65, strength: 0.65, noise: 0.2, label: 'Balanced (65%)', shortLabel: 'Balanced', desc: 'Balanced style & timbre transformation' },
  { id: '0.85', value: 0.85, strength: 0.85, noise: 0.35, label: 'Bold (85%)', shortLabel: 'Bold', desc: 'Deep genre & instrumentation transformation' },
  { id: '1', value: 1.0, strength: 1.0, noise: 0.45, label: 'Full Cover (100%)', shortLabel: 'Full Cover', desc: 'Complete musical reinterpretation' },
];

export const COMPLETE_PRESETS = [
  { id: 'full_band', label: 'Full Band', classes: 'drums, bass, guitar, keyboard, synth', trackClasses: ['drums', 'bass', 'guitar', 'keyboard', 'synth'], desc: 'Complete studio band backing' },
  { id: 'rhythm_section', label: 'Rhythm Section', classes: 'drums, bass, percussion', trackClasses: ['drums', 'bass', 'percussion'], desc: 'Tight groove foundation' },
  { id: 'orchestral', label: 'Cinematic Orchestra', classes: 'strings, brass, woodwinds, percussion', trackClasses: ['strings', 'brass', 'woodwinds', 'percussion'], desc: 'Lush symphonic arrangement' },
  { id: 'electronic', label: 'Electronic Production', classes: 'drums, bass, synth, fx', trackClasses: ['drums', 'bass', 'synth', 'fx'], desc: 'Modern synth & club production' },
  { id: 'acoustic', label: 'Acoustic Ensemble', classes: 'guitar, keyboard, strings, percussion', trackClasses: ['guitar', 'keyboard', 'strings', 'percussion'], desc: 'Warm organic instrumentation' },
];

export const PROMPT_TAGS = [
  'Punchy 808 Bass', 'Warm Analog Synth', 'Crisp Acoustic Drums', 'Airy Lead Vocals',
  'Lush Backing Harmonies', 'Funky Electric Guitar', 'Cinematic Strings', 'Lo-Fi Tape Saturation',
];

export const SCULPT_MODES = [
  { id: 'peak', label: 'Peak Sculpt', axis: 'Y', description: 'Pull up/down to sculpt regional extremes, transient crest, and harmonic drive.' },
  { id: 'design', label: 'Wave Design', axis: 'X', description: 'Pull left/right to warp local tempo progression and RMS sustain texture.' },
];

export function musicOptions(source: Record<string, any>) {
  if (!Array.isArray(source.models) || !Array.isArray(source.languages) || !Array.isArray(source.keys)) throw new Error('Invalid music options');
  const available = source.models.filter((model: any) => typeof model?.name === 'string' && /^acestep-v15-xl-(turbo|sft|base)$/.test(model.name) && Array.isArray(model.supported_task_types));
  const supported = (task: string) => available.filter((model: any) => model.supported_task_types.includes(task)).map((model: any) => model.name.split('-').at(-1) as keyof typeof modes);
  const generation = supported('text2music').filter((id: string) => id !== 'base');
  if (!generation.length || source.languages.some((language: unknown) => typeof language !== 'string') || source.keys.some((key: unknown) => typeof key !== 'string')) throw new Error('Music options are unavailable');
  const languages = new Intl.DisplayNames(['en'], { type: 'language' });
  const taskModes = Object.fromEntries(Object.keys(tasks).map(task => [task, task === 'extract' ? supported('extract') : supported(task === 'extend' ? 'repaint' : task)]));
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
      tracks: TRACK_OPTIONS,
      reworkPresets: REWORK_PRESETS,
      coverPresets: COVER_PRESETS,
      completePresets: COMPLETE_PRESETS,
      promptTags: PROMPT_TAGS,
      sculptModes: SCULPT_MODES,
      duration: { min: 5, max: 300 },
      parameters: {
        coverStrength: number('Source resemblance', 0, 1, { step: 0.05, tasks: ['cover'] }),
        coverNoiseStrength: number('Source detail', 0, 1, { step: 0.05, tasks: ['cover'] }),
        repaintWavCrossfadeSec: number('Transition length (seconds)', 0, 10, { step: 0.01, tasks: ['repaint', 'extend'] }),
        globalCaption: { label: 'Song description', type: 'text', tasks: ['lego'] },
        trackName: {
          label: 'Instrument',
          type: 'select',
          tasks: ['lego', 'extract'],
          options: TRACK_OPTIONS,
        },
        trackClasses: {
          label: 'Instrument groups',
          type: 'multiselect',
          tasks: ['complete'],
          options: TRACK_OPTIONS,
        },
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
