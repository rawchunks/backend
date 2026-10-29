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

