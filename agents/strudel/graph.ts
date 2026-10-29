import { getDrumsLibraryContext } from './drums.js';
import {
  computeStrudelTheoryReference,
  getHarmonyLibraryContext,
  type HarmonyTargetMode,
  type StrudelTheoryReference,
} from './harmony.js';
import { getSynthsLibraryContext, type SynthTargetRole } from './synths.js';
import {
  getArchetypeContext,
  matchStrudelArchetype,
  type ArchetypeId,
} from './archetypes.js';

export type StrudelLayerType = 'drums' | 'bass' | 'chords' | 'arp';
export type ReferenceRoleEdge = 'drums' | 'bass' | 'vocals' | 'keys' | 'master';
export type SectionEnergyNode = 'intro' | 'verse' | 'build' | 'drop' | 'breakdown';

export interface SongStrudelMetadata {
  stylePrompt?: string;
  tags?: string[];
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  stems?: string[];
  activeSection?: string;
  activeLyrics?: string;
}

export interface ComposeStrudelParams {
  songId?: string;
  prompt: string;
  currentCode?: string;
  bpm?: number;
  keyScale?: string;
  stylePrompt?: string;
  timeSignature?: string;
  selectedTrack?: string;
  selection?: { start: number; end: number; trackId?: string };
  playhead?: number;
  stems?: string[];
  tracks?: Array<{ id: string; name: string; type: string; muted?: boolean; solo?: boolean }>;
  musicalContext?: string;
}

export interface ComposerGraphResolution {
  intent: 'compose' | 'transform';
  targetLayers: StrudelLayerType[];
  mountedLibraries: Array<'drums' | 'harmony' | 'synths' | 'archetypes'>;
  archetypeId: ArchetypeId;
  archetypeLabel: string;
  refRole: ReferenceRoleEdge;
  sectionNode: SectionEnergyNode;
  theory: StrudelTheoryReference;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  estimatedTokens: number;
}

const DRUM_KEYWORDS = /\b(drum|drums|kick|bd|snare|sd|clap|cp|hat|hats|hi-hat|hihat|hh|oh|perc|percussion|break|breakbeat|tom|toms|rim|shaker|cymbal|ride|crash|groove|kit|2-step|2step|boom-?bap)\b/i;
const BASS_KEYWORDS = /\b(bass|bassline|sub|sub-bass|303|tb-303|808|reece|acid|low-end|root)\b/i;
const CHORD_KEYWORDS = /\b(chord|chords|pad|pads|voicing|voicings|harmony|harmonic|rhodes|keys|keyboard|piano|organ|stab|stabs|progression)\b/i;
const ARP_KEYWORDS = /\b(arp|arpeggio|arpeggiator|lead|melody|melodic|counter-melody|hook|pluck|bell|synth\s+line|motif|riff)\b/i;
const FULL_STACK_KEYWORDS = /\b(full|stack|arrangement|all\s+layers|complete|orchestrat|multi-layer|entire|everything)\b/i;
const TRANSFORM_ONLY_KEYWORDS = /\b(faster|slower|double\s+time|half\s+time|filter|lpf|hpf|cutoff|reverb|room|delay|echo|pan|louder|quieter|gain|reverse|rev|tweak|adjust|open\s+up|darken|brighten)\b/i;

export function classifyReferenceRoleEdge(selectedTrack?: string): ReferenceRoleEdge {
  const clean = (selectedTrack || 'Master').toLowerCase();
  if (clean.includes('drum') || clean.includes('perc') || clean.includes('beat')) return 'drums';
  if (clean.includes('bass') || clean.includes('sub') || clean.includes('808')) return 'bass';
  if (clean.includes('vocal') || clean.includes('voice') || clean.includes('sing')) return 'vocals';
  if (clean.includes('key') || clean.includes('piano') || clean.includes('synth') || clean.includes('guitar') || clean.includes('chord')) return 'keys';
  return 'master';
}

export function classifySectionEnergyNode(activeSection?: string): SectionEnergyNode {
  const clean = (activeSection || 'Main').toLowerCase();
  if (clean.includes('intro')) return 'intro';
  if (clean.includes('break') || clean.includes('outro') || clean.includes('bridge')) return 'breakdown';
  if (clean.includes('pre') || clean.includes('build') || clean.includes('riser')) return 'build';
  if (clean.includes('chorus') || clean.includes('drop') || clean.includes('hook') || clean.includes('peak')) return 'drop';
  return 'verse';
}

const REFERENCE_ROLE_EDGES: Record<ReferenceRoleEdge, string> = {
  drums: 'Ref=DRUMS: Lock bass and chord downbeats tightly to the kick transient grid; place syncopated offbeats and arpeggios into open 16th-note pockets.',
  bass: 'Ref=BASS: Keep basslines monophonic in Octave 2 (Root/5th/Octave), locking downbeats to the kick and weaving syncopated 16th-note octave jumps.',
  vocals: 'Ref=VOCALS: Carve a clear midrange vocal pocket — low-pass warm pads/bass (.lpf(1100)) and high-pass shimmering arps/hats (.hpf(750)).',
  keys: 'Ref=KEYS: Lock harmonic rhythm to the 4-bar chord progression and avoid competing mid-register chord clusters.',
  master: 'Ref=MASTER: Balance frequency registers cleanly across stack() layers with controlled headroom.',
};

const SECTION_ENERGY_EDGES: Record<SectionEnergyNode, string> = {
  intro: 'Section=INTRO: Spacious, atmospheric entry — filtered timbres (.lpf(1200)), deeper reverb (.room(0.45)), sparse rhythmic density.',
  verse: 'Section=VERSE: Locked-in, hypnotic pocket — tight groove with subtle 4-bar <...> evolution and controlled headroom.',
  build: 'Section=BUILD/PRE-CHORUS: Rising momentum — faster subdivisions (*2, *4), opening filter cutoffs (.lpf(2800)), driving snare/hat energy.',
  drop: 'Section=CHORUS/DROP: Peak energy — punchy transients, locked sub-bass, full harmonic voicings, and wide stereo movement (.pan()).',
  breakdown: 'Section=BREAKDOWN/OUTRO: Stripped-back contrast — remove heavy kick clutter, emphasize lush chords/echoes (.room(0.5), .delay(0.3)).',
};

/**
 * Traverses the Algorithmic Composer Directed Graph in <1ms to select ONLY the relevant
 * internal library slices, role complementarity edge, section energy edge, and genre archetype.
 */
export function resolveComposerGraph(
  params: ComposeStrudelParams,
  songMeta: SongStrudelMetadata = {}
): ComposerGraphResolution {
  const bpm = params.bpm ?? songMeta.bpm ?? 120;
  const keyScale = params.keyScale || songMeta.keyScale || 'C minor';
  const timeSignature = params.timeSignature || songMeta.timeSignature || '4/4';
  const stylePrompt = params.stylePrompt || songMeta.stylePrompt || '';
  const tags = songMeta.tags || [];
  const stems = params.stems?.length ? params.stems : songMeta.stems || [];
  const refTrack = params.selectedTrack || 'Master';
  const activeSection = songMeta.activeSection || 'Main';
  const activeLyrics = songMeta.activeLyrics || '';
  const resolvedContext = (params.musicalContext || '').trim();
  const prompt = params.prompt.trim();
  const currentCode = (params.currentCode || '').trim();

  const theory = computeStrudelTheoryReference(keyScale);
  const refRole = classifyReferenceRoleEdge(refTrack);
  const sectionNode = classifySectionEnergyNode(activeSection);
  const archetype = matchStrudelArchetype({ prompt, stylePrompt, tags, bpm });

  const layerPrompt = prompt.replace(
    /\b(?:lock(?:ing|ed)?\s+(?:to|with|into)|around|over|against|under|complement(?:ing)?)\s+(?:the\s+)?(?:kick|drums?|beat|bass|bassline|vocals?|keys|chords?)\b/gi,
    ''
  );
  const hasDrums = DRUM_KEYWORDS.test(layerPrompt);
  const hasBass = BASS_KEYWORDS.test(layerPrompt);
  const hasChords = CHORD_KEYWORDS.test(layerPrompt);
  const hasArp = ARP_KEYWORDS.test(layerPrompt);
  const wantsFullStack = FULL_STACK_KEYWORDS.test(layerPrompt);
  const isPureTransform =
    Boolean(currentCode) &&
    TRANSFORM_ONLY_KEYWORDS.test(prompt) &&
    !hasDrums &&
    !hasBass &&
    !hasChords &&
    !hasArp &&
    !wantsFullStack;

  const layers = new Set<StrudelLayerType>();
  if (isPureTransform) {
    if (/\b(?:s|sound)\s*\(/.test(currentCode)) layers.add('drums');
    if (/\bnote\s*\(/.test(currentCode)) layers.add('bass');
    if (/\bn\s*\(/.test(currentCode)) layers.add('arp');
    if (layers.size === 0) layers.add('bass');
  } else if (wantsFullStack || (!hasDrums && !hasBass && !hasChords && !hasArp)) {
    layers.add('drums');
    layers.add('bass');
    layers.add('chords');
    layers.add('arp');
  } else {
    if (hasDrums) layers.add('drums');
    if (hasBass) layers.add('bass');
    if (hasChords) layers.add('chords');
    if (hasArp) layers.add('arp');
  }

  const intent: 'compose' | 'transform' = currentCode ? 'transform' : 'compose';
  const mountedLibraries: Array<'drums' | 'harmony' | 'synths' | 'archetypes'> = [];
  const libraryBlocks: string[] = [];

  if (layers.has('drums') && !isPureTransform) {
    mountedLibraries.push('drums');
    libraryBlocks.push(getDrumsLibraryContext());
  }

  const needsHarmony = layers.has('bass') || layers.has('chords') || layers.has('arp');
  if (needsHarmony && !isPureTransform) {
    mountedLibraries.push('harmony');
    let harmonyMode: HarmonyTargetMode = 'full';
    if (layers.size === 1) {
      if (layers.has('bass')) harmonyMode = 'bass';
      else if (layers.has('chords')) harmonyMode = 'chords';
      else if (layers.has('arp')) harmonyMode = 'arp';
    } else if (!layers.has('chords') && !layers.has('arp') && layers.has('bass')) {
      harmonyMode = 'bass';
    }
    libraryBlocks.push(getHarmonyLibraryContext(theory, harmonyMode));
  }

  let synthRole: SynthTargetRole = 'full';
  if (isPureTransform) synthRole = 'transform';
  else if (layers.size === 1 && layers.has('bass')) synthRole = 'bass';
  else if (layers.size === 1 && layers.has('chords')) synthRole = 'chords';
  else if (layers.size === 1 && layers.has('arp')) synthRole = 'arp';

  if (needsHarmony || isPureTransform) {
    mountedLibraries.push('synths');
    libraryBlocks.push(getSynthsLibraryContext(synthRole));
  } else {
    // Drums-only: inject ultra-compact 1-line modifier rule instead of full synth oscillator library
    libraryBlocks.push(
      '[DSP MODIFIERS] Chain only .gain(0..1.5), .lpf(100..12000), .hpf(20..4000), .room(0..1), .delay(0..0.9), .pan(-1..1), .fast(n), .slow(n), .rev(). Never use .every(), .jux(), .off(), .crush(), or .euclid().'
    );
  }

  if (!isPureTransform) {
    mountedLibraries.push('archetypes');
    libraryBlocks.push(getArchetypeContext(archetype, theory, layers));
  }

  const systemPrompt = [
    'You are the Rawchunks Algorithmic Composer. Pre-routed libraries are mounted below; call `read_*_library` only if an unmounted library is needed, then call `set_strudel_pattern({ reasoning, code })` with raw executable Strudel code (no markdown fences or comments).',
    `[GRAPH LOCK — ${bpm} BPM | ${timeSignature} | Key: ${theory.keyScale} (.scale("${theory.strudelScaleName}"))]`,
    '- Mini-Notation: space = 1-bar subdivision; [a b] = sub-step; [a,b,c] = chord; ~ = rest; *N = fast; /N = slow; <bar1 bar2 bar3 bar4> = 1 outer 4-bar cycle group; stack(...) = multi-layer.',
    `- ${REFERENCE_ROLE_EDGES[refRole]}`,
    `- ${SECTION_ENERGY_EDGES[sectionNode]}`,
    ...libraryBlocks,
  ].join('\n');

  const userLines = [
    `USER REQUEST: ${prompt}`,
    `REFERENCE TRACK: ${refTrack} | ACTIVE SECTION: [${activeSection}] | WINDOW: ${
      params.selection
        ? `${params.selection.start.toFixed(2)}s-${params.selection.end.toFixed(2)}s`
        : `${(params.playhead ?? 0).toFixed(2)}s`
    }`,
    stylePrompt ? `SONG STYLE: ${stylePrompt}` : '',
    tags.length ? `TAGS: ${tags.join(', ')}` : '',
    stems.length ? `ACTIVE STEMS: ${stems.join(', ')}` : '',
    activeLyrics ? `ACTIVE LYRICS: "${activeLyrics}"` : '',
    resolvedContext ? `MUSICAL CONTEXT:\n${resolvedContext}` : '',
    currentCode ? `CURRENT EDITOR CODE:\n${currentCode}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userLines },
  ];

  const totalChars = systemPrompt.length + userLines.length;
  const estimatedTokens = Math.ceil(totalChars / 4);

  return {
    intent,
    targetLayers: Array.from(layers),
    mountedLibraries,
    archetypeId: archetype.id,
    archetypeLabel: archetype.label,
    refRole,
    sectionNode,
    theory,
    messages,
    estimatedTokens,
  };
}

/**
 * Builds the Directed-Graph-routed composer messages for Nemotron-3-Ultra.
 */
export function buildStrudelComposerMessages(
  params: ComposeStrudelParams,
  songMeta: SongStrudelMetadata = {}
): Array<{ role: 'system' | 'user'; content: string }> {
  return resolveComposerGraph(params, songMeta).messages;
}
