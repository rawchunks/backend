import type { FastifyPluginAsync } from 'fastify';
import { client } from './generation/client.js';

export interface TagItem {
  id: string;
  label: string;
  desc: string;
}

export interface TagCategory {
  id: string;
  label: string;
  desc: string;
  max?: number;
  tags: TagItem[];
}

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

export const MAX_GENRE_TAGS = 3;
export const MAX_PRODUCTION_TAGS = 4;
export const MAX_MOOD_TAGS = 3;
export const MAX_VOCAL_TAGS = 4;

export const GENRE_CATEGORIES: TagCategory[] = [
  {
    id: 'pop',
    label: 'Pop',
    desc: 'Hook-driven melodies, modern vocal production, and crossover appeal',
    tags: [
      { id: 'Pop', label: 'Pop', desc: 'Core contemporary pop structure with immediate melodic hooks' },
      { id: 'Synth-Pop', label: 'Synth-Pop', desc: 'Synthesizer-led pop hooks with driving electronic pulse' },
      { id: 'Indie Pop', label: 'Indie Pop', desc: 'Organic, characterful pop with bright guitars and intimate charm' },
      { id: 'Dream Pop', label: 'Dream Pop', desc: 'Shimmering, reverb-drenched textures and hazy melodic vocals' },
      { id: 'Bedroom Pop', label: 'Bedroom Pop', desc: 'Warm, DIY close-mic intimacy and soft lo-fi charm' },
      { id: 'Hyperpop', label: 'Hyperpop', desc: 'Maximalist, pitch-shifted glitch energy and shiny synth leads' },
      { id: 'Dance-Pop', label: 'Dance-Pop', desc: 'Club-ready four-on-the-floor beats with infectious pop choruses' },
      { id: 'Dark Pop', label: 'Dark Pop', desc: 'Moody minor-key basslines and sleek nocturnal pop tension' },
      { id: 'Chamber Pop', label: 'Chamber Pop', desc: 'Orchestral strings, piano, and lush baroque pop arrangements' },
      { id: 'Anthemic Pop', label: 'Anthemic Pop', desc: 'Stadium-sized builds and soaring, sing-along choruses' },
      { id: 'K-Pop', label: 'K-Pop', desc: 'High-energy, multi-section choreography pop with sharp transitions' },
      { id: 'City Pop', label: 'City Pop', desc: 'Sophisticated 80s Japanese boogie, slap bass, and lush electric keys' },
    ],
  },
  {
    id: 'electronic',
    label: 'Electronic',
    desc: 'Synthesizers, club percussion, bass design, and festival energy',
    tags: [
      { id: 'EDM', label: 'EDM', desc: 'Festival electronic dance production with big builds and drops' },
      { id: 'Synthwave', label: 'Synthwave', desc: 'Retro-futuristic 80s analog arpeggios and gated drum machines' },
      { id: 'House', label: 'House', desc: 'Classic four-on-the-floor club groove with warm bass and vocal hooks' },
      { id: 'Electro House', label: 'Electro House', desc: 'Aggressive buzzsaw basslines and punchy peak-hour club drums' },
      { id: 'French House', label: 'French House', desc: 'Filtered disco loops, phaser sweeps, and sidechained funk bass' },
      { id: 'Techno', label: 'Techno', desc: 'Relentless, hypnotic industrial kick pulse and modular synth textures' },
      { id: 'Trance', label: 'Trance', desc: 'Euphoric arpeggiated supersaw leads and long emotional breakdowns' },
      { id: 'Drum and Bass', label: 'Drum and Bass', desc: 'Fast breakbeat percussion (~174 BPM) over deep rolling sub-bass' },
      { id: 'Dubstep', label: 'Dubstep', desc: 'Half-time heavy snare groove with modulated wobble and growl bass' },
      { id: 'Future Bass', label: 'Future Bass', desc: 'Detuned sidechained supersaw chord swells and trap-inflected drums' },
      { id: 'Eurobeat', label: 'Eurobeat', desc: 'High-octane brassy synth riffs and relentless hi-NRG tempo' },
      { id: 'Chiptune', label: 'Chiptune', desc: '8-bit and 16-bit square-wave arcade melodies and rapid arpeggios' },
    ],
  },
  {
    id: 'hiphop',
    label: 'Hip-Hop',
    desc: '808 sub-bass, sampled breakbeats, trap hi-hats, and rhythmic bounce',
    tags: [
      { id: 'Hip-Hop', label: 'Hip-Hop', desc: 'Head-nodding drum pocket, weighty bass, and vocal-forward groove' },
      { id: 'Trap', label: 'Trap', desc: 'Booming 808 sub-bass, rapid hi-hat rolls, and snappy snare patterns' },
      { id: 'Boom Bap', label: 'Boom Bap', desc: 'Punchy acoustic drum breaks and chopped golden-era sample feel' },
      { id: 'Lo-Fi Hip-Hop', label: 'Lo-Fi Hip-Hop', desc: 'Dusty swung drums, warm jazz piano chords, and relaxed study vibe' },
      { id: 'Modern Trap', label: 'Modern Trap', desc: 'Sleek contemporary 808 glides, dark melodies, and crisp hi-hat bounce' },
      { id: 'Phonk', label: 'Phonk', desc: 'Distorted 808 cowbell melodies, Memphis tape grit, and drift energy' },
      { id: 'Latin Trap', label: 'Latin Trap', desc: 'Heavy trap 808s blended with moody Latin cadences and reggaeton bounce' },
      { id: 'Trip-Hop', label: 'Trip-Hop', desc: 'Slow, cinematic downtempo breakbeats with dark atmospheric textures' },
      { id: 'Electronic Rap', label: 'Electronic Rap', desc: 'Synthesizer-driven club beats fused with rhythmic rap cadences' },
      { id: 'Hip-House', label: 'Hip-House', desc: 'Upbeat house piano and four-on-the-floor groove with rap delivery' },
      { id: 'Old School Rap', label: 'Old School Rap', desc: 'Classic breakbeat funk foundation with Turntable scratch aesthetics' },
      { id: 'B-Boy Funk Rap', label: 'B-Boy Funk Rap', desc: '1980s block-party brass stabs, live slap bass, and breakdance drums' },
    ],
  },
  {
    id: 'rock',
    label: 'Rock & Metal',
    desc: 'Amplified electric guitars, live drum kits, and high-voltage band drive',
    tags: [
      { id: 'Rock', label: 'Rock', desc: 'Driving electric guitars, punchy bass, and live acoustic drums' },
      { id: 'Indie Rock', label: 'Indie Rock', desc: 'Jangly rhythm guitars, melodic basslines, and raw band chemistry' },
      { id: 'Alternative Rock', label: 'Alternative Rock', desc: 'Dynamic quiet-to-loud guitar shifts and expressive rock hooks' },
      { id: 'Classic Rock', label: 'Classic Rock', desc: 'Vintage tube-amp guitar riffs, blues-rock solos, and Hammond warmth' },
      { id: 'Pop-Rock', label: 'Pop-Rock', desc: 'Radio-ready melodic hooks backed by energetic electric guitars' },
      { id: 'Post-Punk', label: 'Post-Punk', desc: 'Angular basslines, motorik drum drive, and chorus-drenched guitars' },
      { id: 'Shoegaze', label: 'Shoegaze', desc: 'Towering walls of fuzz and reverb guitars with buried ethereal vocals' },
      { id: 'Grunge', label: 'Grunge', desc: 'Sludgy overdriven guitar riffs, raw angst, and heavy 90s dynamics' },
      { id: 'Punk Rock', label: 'Punk Rock', desc: 'Fast downstroke power chords, urgent tempo, and stripped-back attitude' },
      { id: 'Post-Rock', label: 'Post-Rock', desc: 'Cinematic instrumental crescendos with tremolo guitars and spacious delay' },
      { id: 'Symphonic Metal', label: 'Symphonic Metal', desc: 'Heavy double-kick metal riffs fused with operatic choir and orchestra' },
      { id: 'Heavy Metal', label: 'Heavy Metal', desc: 'High-gain palm-muted guitar riffs, double-bass drums, and aggressive power' },
    ],
  },
  {
    id: 'rnb',
    label: 'R&B & Soul',
    desc: 'Lush extended chords, pocket grooves, funk basslines, and soulful warmth',
    tags: [
      { id: 'R&B', label: 'R&B', desc: 'Smooth vocal melodies over warm Rhodes chords and tight pocket drums' },
      { id: 'Contemporary R&B', label: 'Contemporary R&B', desc: 'Modern sub-bass, crisp trap-soul percussion, and intimate vocal layering' },
      { id: 'Rhythm and Blues', label: 'Rhythm and Blues', desc: 'Classic horn-backed groove, bluesy guitar fills, and soulful rhythm section' },
      { id: 'Neo-Soul', label: 'Neo-Soul', desc: 'Unquantized Dilla-style swing, jazz-voiced Rhodes, and warm bass' },
      { id: 'Classic Soul', label: 'Classic Soul', desc: 'Motown and Stax-inspired brass sections, tambourine, and heartfelt vocals' },
      { id: 'Vintage Soul', label: 'Vintage Soul', desc: 'Warm analog tape soul with live rhythm section and retro horn arrangements' },
      { id: 'Soul', label: 'Soul', desc: 'Gospel-rooted vocal passion with rich organ and expressive groove' },
      { id: 'Funk', label: 'Funk', desc: 'Syncopated 16th-note scratch guitar, slap bass, and tight horn stabs' },
      { id: 'Disco', label: 'Disco', desc: 'Four-on-the-floor hi-hat groove, octave basslines, and sweeping strings' },
      { id: 'Gospel', label: 'Gospel', desc: 'Uplifting choir harmonies, Hammond B3 organ swells, and handclaps' },
      { id: 'Blues', label: 'Blues', desc: 'Expressive bent-note guitar phrasing, shuffle groove, and raw storytelling' },
      { id: 'Slow Jam', label: 'Slow Jam', desc: 'Sensual, late-night slow-tempo R&B ballad with silky synth pads' },
    ],
  },
  {
    id: 'jazz',
    label: 'Jazz & Classical',
    desc: 'Acoustic swing, brass improvisation, piano repertoire, and orchestral scoring',
    tags: [
      { id: 'Jazz', label: 'Jazz', desc: 'Swung ride cymbal, walking bass, extended harmony, and horn solos' },
      { id: 'Smooth Jazz', label: 'Smooth Jazz', desc: 'Polished saxophone melodies, electric piano, and laid-back groove' },
      { id: 'Bebop', label: 'Bebop', desc: 'Fast-tempo virtuosic horn lines, complex chord changes, and brisk swing' },
      { id: 'Cool Jazz', label: 'Cool Jazz', desc: 'Relaxed, late-night lounge phrasing with brushed drums and muted brass' },
      { id: 'Classic Jazz', label: 'Classic Jazz', desc: 'Acoustic trio or quartet foundation with upright bass and grand piano' },
      { id: 'Lo-Fi Jazz', label: 'Lo-Fi Jazz', desc: 'Mellow jazz chord progressions blended with warm dusty textures' },
      { id: 'Big Band', label: 'Big Band', desc: 'Full brass and woodwind ensemble with swinging horn section tutti' },
      { id: 'Swing', label: 'Swing', desc: 'Propulsive triplet-feel rhythm section and classic dancehall energy' },
      { id: 'Classical', label: 'Classical', desc: 'Formal acoustic composition with expressive dynamic phrasing' },
      { id: 'Chamber Music', label: 'Chamber Music', desc: 'Intimate small-ensemble strings, woodwinds, and piano interplay' },
      { id: 'Romantic Era', label: 'Romantic Era', desc: 'Lush 19th-century harmonic chromaticism and sweeping rubato dynamics' },
      { id: 'Orchestral', label: 'Orchestral', desc: 'Full symphonic strings, brass, woodwinds, and dramatic percussion' },
    ],
  },
  {
    id: 'world',
    label: 'World & Folk',
    desc: 'Acoustic roots, Latin percussion, Iberian guitar, and global grooves',
    tags: [
      { id: 'Folk', label: 'Folk', desc: 'Acoustic guitar strumming, organic instrumentation, and intimate storytelling' },
      { id: 'Indie Folk', label: 'Indie Folk', desc: 'Warm fingerpicked acoustic guitars with layered vocal harmonies' },
      { id: 'Americana', label: 'Americana', desc: 'Roots-rock blend of acoustic guitar, pedal steel, and heartland grit' },
      { id: 'Country', label: 'Country', desc: 'Twangy telecaster licks, acoustic strumming, fiddle, and narrative hooks' },
      { id: 'Bluegrass', label: 'Bluegrass', desc: 'Fast acoustic picking on banjo, mandolin, fiddle, and upright bass' },
      { id: 'Bossa Nova', label: 'Bossa Nova', desc: 'Syncopated nylon-string guitar, soft brushed percussion, and jazz harmony' },
      { id: 'Samba', label: 'Samba', desc: 'Celebratory Brazilian percussion ensemble with vibrant cavaquinho and brass' },
      { id: 'Reggaeton', label: 'Reggaeton', desc: 'Driving dembow drum pattern, heavy sub-bass, and infectious Latin hooks' },
      { id: 'Latin Pop', label: 'Latin Pop', desc: 'Catchy Spanish/Latin melodies backed by tropical percussion and acoustic guitar' },
      { id: 'Afrobeat', label: 'Afrobeat', desc: 'Polyrhythmic shakers and log drums, bright guitar ostinatos, and horn riffs' },
      { id: 'Flamenco', label: 'Flamenco', desc: 'Virtuosic Spanish nylon guitar rasgueado, palmas handclaps, and cajón' },
      { id: 'Reggae', label: 'Reggae', desc: 'Laid-back offbeat guitar skank, deep melodic bassline, and one-drop drums' },
    ],
  },
];

export const PRODUCTION_CATEGORIES: TagCategory[] = [
  {
    id: 'timbre',
    label: 'Timbre',
    desc: 'Overall harmonic color, frequency balance, and tonal surface (select 1)',
    max: 1,
    tags: [
      { id: 'Warm', label: 'Warm', desc: 'Rich low-mid body and smooth, rounded upper frequencies' },
      { id: 'Bright', label: 'Bright', desc: 'Forward upper-harmonic sheen and crisp top-end presence' },
      { id: 'Crisp', label: 'Crisp', desc: 'Articulate, well-defined transient attack and high-frequency clarity' },
      { id: 'Airy', label: 'Airy', desc: 'Open high-frequency breath and spacious upper register' },
      { id: 'Punchy', label: 'Punchy', desc: 'Tight dynamic impact with fast, focused transient snap' },
      { id: 'Lush', label: 'Lush', desc: 'Dense, richly layered harmonic depth and wide texture' },
      { id: 'Raw', label: 'Raw', desc: 'Unvarnished, direct signal with natural organic edge' },
      { id: 'Polished', label: 'Polished', desc: 'Refined, commercial sheen with smooth frequency balance' },
      { id: 'Gritty', label: 'Gritty', desc: 'Textured harmonic bite and rough midrange grain' },
      { id: 'Muddy', label: 'Muddy', desc: 'Thick, dark low-mid density with rolled-off highs' },
      { id: 'Clean', label: 'Clean', desc: 'Transparent, uncolored tone with zero harmonic breakup' },
      { id: 'Smooth', label: 'Smooth', desc: 'Silky, even midrange response free of harsh peaks' },
    ],
  },
  {
    id: 'production',
    label: 'Production',
    desc: 'Recording medium, acoustic environment, and signal fidelity (select 1)',
    max: 1,
    tags: [
      { id: 'Analog Warmth', label: 'Analog Warmth', desc: 'Classic hardware console and transformer harmonic coloration' },
      { id: 'Tape Saturation', label: 'Tape Saturation', desc: 'Magnetic tape compression and gentle soft-clipping warmth' },
      { id: 'Vinyl Crackle', label: 'Vinyl Crackle', desc: 'Nostalgic record surface dust and warm turntable needle texture' },
      { id: 'Lo-Fi Processing', label: 'Lo-Fi Processing', desc: 'Bandwidth-limited vintage sampler and cassette character' },
      { id: 'High-Fidelity', label: 'High-Fidelity', desc: 'Full-spectrum audiophile clarity and pristine dynamic headroom' },
      { id: 'Live Recording', label: 'Live Recording', desc: 'Authentic stage performance energy and natural room ambience' },
      { id: 'Studio-Polished', label: 'Studio-Polished', desc: 'Tightly controlled, radio-ready modern master finish' },
      { id: 'Live Room Recording', label: 'Live Room Recording', desc: 'Natural acoustic reflections of instruments tracked together in one room' },
    ],
  },
  {
    id: 'mix',
    label: 'Mix',
    desc: 'Stereo width, dynamic pumping, spatial reverb, and saturation drive (select 1)',
    max: 1,
    tags: [
      { id: 'Wide Stereo', label: 'Wide Stereo', desc: 'Expansive left-right stereo imaging and panoramic width' },
      { id: 'Compression', label: 'Compression', desc: 'Glued dynamic range with consistent upfront sustain' },
      { id: 'Sidechain', label: 'Sidechain', desc: 'Rhythmic volume ducking locked to the kick drum pulse' },
      { id: 'Sidechain Pumping', label: 'Sidechain Pumping', desc: 'Pronounced club-style rhythmic breathing across chords and pads' },
      { id: 'Reverb', label: 'Reverb', desc: 'Natural acoustic room decay and cohesive spatial blend' },
      { id: 'Cathedral Reverb', label: 'Cathedral Reverb', desc: 'Long, majestic stone-hall reverb tail and sacred space' },
      { id: 'Deep Reverb', label: 'Deep Reverb', desc: 'Immersive, lush spatial depth behind the dry foreground' },
      { id: 'Cavernous Reverb', label: 'Cavernous Reverb', desc: 'Vast, echoing subterranean acoustic expanse' },
      { id: 'Delay', label: 'Delay', desc: 'Rhythmic tempo-synced echoes adding movement and depth' },
      { id: 'Distortion', label: 'Distortion', desc: 'Overdriven harmonic clipping and aggressive signal grit' },
      { id: 'High-Gain Distortion', label: 'High-Gain Distortion', desc: 'Heavy amplifier saturation for maximum sustain and bite' },
      { id: 'Wall of Sound', label: 'Wall of Sound', desc: 'Massive, densely stacked arrangement filling the full spectrum' },
    ],
  },
  {
    id: 'era',
    label: 'Era',
    desc: 'Signature decade production palette and period aesthetic (select 1)',
    max: 1,
    tags: [
      { id: '80s Synth-Pop', label: '80s Synth-Pop', desc: 'Gated snare reverb, analog polysynths, and 1980s studio sheen' },
      { id: '90s Grunge', label: '90s Grunge', desc: 'Raw 1990s alternative guitar fuzz and unpolished tape dynamics' },
      { id: '2010s EDM', label: '2010s EDM', desc: 'Mainstage festival supersaws, risers, and high-impact drops' },
      { id: 'Retro 80s Synths', label: 'Retro 80s Synths', desc: 'Nostalgic analog oscillators, chorus bass, and neon synth tone' },
    ],
  },
];

export const MOOD_CATEGORIES: TagCategory[] = [
  {
    id: 'upbeat',
    label: 'Uplifting',
    desc: 'Radiant, high-spirit, and celebratory emotional energy',
    tags: [
      { id: 'Uplifting', label: 'Uplifting', desc: 'Soaring harmonic lift that inspires optimism and elevation' },
      { id: 'Euphoric', label: 'Euphoric', desc: 'Peak-rush emotional release and ecstatic melodic highs' },
      { id: 'Happy', label: 'Happy', desc: 'Bright major-key warmth and sunny, approachable positivity' },
      { id: 'Energetic', label: 'Energetic', desc: 'Lively rhythmic momentum and animated forward motion' },
      { id: 'Upbeat', label: 'Upbeat', desc: 'Brisk, buoyant groove with an infectious positive bounce' },
      { id: 'Feel-Good', label: 'Feel-Good', desc: 'Effortless, crowd-pleasing warmth and infectious groove' },
      { id: 'Playful', label: 'Playful', desc: 'Lighthearted, bouncy phrasing with whimsical rhythmic turns' },
      { id: 'Vibrant', label: 'Vibrant', desc: 'Colorful, full-bodied arrangement bursting with life' },
      { id: 'Carefree', label: 'Carefree', desc: 'Breezy, unburdened open-road or summer-afternoon ease' },
      { id: 'Joyful', label: 'Joyful', desc: 'Radiant, wholehearted celebration in melody and rhythm' },
      { id: 'Celebratory', label: 'Celebratory', desc: 'Festive party energy built for collective movement' },
      { id: 'Cheerful', label: 'Cheerful', desc: 'Light, whistling-bright melody and friendly acoustic bounce' },
    ],
  },
  {
    id: 'driving',
    label: 'Driving',
    desc: 'Propulsive momentum, stadium scale, and high-impact intensity',
    tags: [
      { id: 'Anthemic', label: 'Anthemic', desc: 'Larger-than-life chorus built for stadium sing-alongs' },
      { id: 'Triumphant', label: 'Triumphant', desc: 'Victorious brass and chord resolutions evoking conquest' },
      { id: 'Driving', label: 'Driving', desc: 'Locked-in rhythmic pulse that pushes forward without letup' },
      { id: 'Aggressive', label: 'Aggressive', desc: 'Hard-hitting transient attack and confrontational intensity' },
      { id: 'Fierce', label: 'Fierce', desc: 'Bold, commanding performance with razor-sharp attitude' },
      { id: 'Frantic', label: 'Frantic', desc: 'Breathless, high-velocity urgency and rapid-fire subdivisions' },
      { id: 'Pumping', label: 'Pumping', desc: 'Heavy club-floor pulse with rhythmic dynamic surge' },
      { id: 'Heroic', label: 'Heroic', desc: 'Noble, courageous theme suited for climactic moments' },
      { id: 'Powerful', label: 'Powerful', desc: 'Commanding low-end weight and full-chested dynamic authority' },
      { id: 'Relentless', label: 'Relentless', desc: 'Unstoppable mechanical or percussive forward momentum' },
      { id: 'Explosive', label: 'Explosive', desc: 'High-contrast dynamic eruptions and dramatic drops' },
      { id: 'High-Octane', label: 'High-Octane', desc: 'Adrenaline-fueled speed and maximum kinetic energy' },
    ],
  },
  {
    id: 'emotional',
    label: 'Melancholic',
    desc: 'Reflective, vulnerable, and deeply moving emotional weight',
    tags: [
      { id: 'Melancholic', label: 'Melancholic', desc: 'Aching minor-key reflection and quiet emotional longing' },
      { id: 'Bittersweet', label: 'Bittersweet', desc: 'Major-minor harmonic tension blending warmth with sorrow' },
      { id: 'Nostalgic', label: 'Nostalgic', desc: 'Wistful look back evoked through warm, memory-laden tones' },
      { id: 'Sad', label: 'Sad', desc: 'Slow, sorrowful melodic phrasing and sparse accompaniment' },
      { id: 'Heartfelt', label: 'Heartfelt', desc: 'Sincere, unguarded emotional honesty in melody and lyric' },
      { id: 'Wistful', label: 'Wistful', desc: 'Gentle, yearning reflection with delicate harmonic movement' },
      { id: 'Vulnerable', label: 'Vulnerable', desc: 'Close, fragile performance that feels personal and exposed' },
      { id: 'Poignant', label: 'Poignant', desc: 'Sharp, touching melodic beauty that lingers emotionally' },
      { id: 'Tender', label: 'Tender', desc: 'Soft, affectionate touch with gentle dynamic restraint' },
      { id: 'Emotional', label: 'Emotional', desc: 'Swelling dynamic arc designed to build toward a cathartic peak' },
      { id: 'Heartbreaking', label: 'Heartbreaking', desc: 'Devastatingly raw balladry and weeping melodic lines' },
      { id: 'Somber', label: 'Somber', desc: 'Solemn, low-register gravity and restrained pace' },
    ],
  },
  {
    id: 'dark',
    label: 'Dark',
    desc: 'Shadowy, suspenseful, and brooding nocturnal tension',
    tags: [
      { id: 'Dark', label: 'Dark', desc: 'Shadowy low-register tonality and minor-mode weight' },
      { id: 'Moody', label: 'Moody', desc: 'Smoky, late-night introspection with shifting harmonic shade' },
      { id: 'Tense', label: 'Tense', desc: 'Unresolved dissonance and tight rhythmic suspense' },
      { id: 'Mysterious', label: 'Mysterious', desc: 'Enigmatic modal melodies and shadowy sonic intrigue' },
      { id: 'Haunting', label: 'Haunting', desc: 'Ghostly, lingering melodies that echo in deep space' },
      { id: 'Menacing', label: 'Menacing', desc: 'Threatening sub-bass weight and stalking rhythmic grit' },
      { id: 'Gothic', label: 'Gothic', desc: 'Cathedral-dark romanticism with ornate minor harmonies' },
      { id: 'Brooding', label: 'Brooding', desc: 'Slow-burning, simmering low-end intensity' },
      { id: 'Cold', label: 'Cold', desc: 'Stark, icy digital precision and detached industrial air' },
      { id: 'Dramatic', label: 'Dramatic', desc: 'Theatrical dynamic contrasts and high-stakes harmonic turns' },
      { id: 'Chaotic', label: 'Chaotic', desc: 'Unpredictable rhythmic fractures and swirling sonic density' },
      { id: 'Ominous', label: 'Ominous', desc: 'Foreboding low drones and gathering storm tension' },
    ],
  },
  {
    id: 'chill',
    label: 'Dreamy',
    desc: 'Weightless, serene, and laid-back sonic relaxation',
    tags: [
      { id: 'Dreamy', label: 'Dreamy', desc: 'Soft-focus chords and weightless, cloud-like melodic drift' },
      { id: 'Ethereal', label: 'Ethereal', desc: 'Otherworldly, angelic shimmer suspended in open reverb' },
      { id: 'Chill', label: 'Chill', desc: 'Unhurried, low-stress groove for effortless listening' },
      { id: 'Relaxing', label: 'Relaxing', desc: 'Gentle, consonant progressions that release tension' },
      { id: 'Relaxed', label: 'Relaxed', desc: 'Loose, behind-the-beat pocket with warm dynamics' },
      { id: 'Meditative', label: 'Meditative', desc: 'Still, centered tonal sustain for deep focus and calm' },
      { id: 'Peaceful', label: 'Peaceful', desc: 'Tranquil acoustic or ambient stillness without sharp transients' },
      { id: 'Hypnotic', label: 'Hypnotic', desc: 'Mesmerizing, cyclical patterns that draw the listener inward' },
      { id: 'Floating', label: 'Floating', desc: 'Zero-gravity pad textures without heavy rhythmic anchoring' },
      { id: 'Soothing', label: 'Soothing', desc: 'Balmy, comforting tones that smooth out harsh edges' },
      { id: 'Cozy', label: 'Cozy', desc: 'Warm, close-up acoustic intimacy like a quiet rainy evening' },
      { id: 'Laid-Back', label: 'Laid-Back', desc: 'Easygoing, unforced tempo with a relaxed swing' },
    ],
  },
  {
    id: 'atmosphere',
    label: 'Cinematic',
    desc: 'Immersive world-building and environmental soundscapes',
    tags: [
      { id: 'Cinematic', label: 'Cinematic', desc: 'Widescreen film-score scale and evocative visual storytelling' },
      { id: 'Intimate', label: 'Intimate', desc: 'Whisper-close proximity as if performed right beside the listener' },
      { id: 'Atmospheric', label: 'Atmospheric', desc: 'Rich environmental pads and immersive spatial textures' },
      { id: 'Nocturnal', label: 'Nocturnal', desc: 'After-hours city glow and late-night highway mood' },
      { id: 'Futuristic', label: 'Futuristic', desc: 'Sci-fi synthesis, gleaming digital timbres, and forward-looking design' },
      { id: 'Neon Atmosphere', label: 'Neon Atmosphere', desc: 'Cyberpunk rain, glowing analog synths, and midnight reflections' },
      { id: 'Cozy Cafe Atmosphere', label: 'Cozy Cafe Atmosphere', desc: 'Intimate coffeehouse acoustics with warm wood and soft brush groove' },
      { id: 'Space Ambient', label: 'Space Ambient', desc: 'Vast cosmic drones and slow-evolving interstellar pads' },
      { id: 'Nature Ambient', label: 'Nature Ambient', desc: 'Organic acoustic serenity evoking open landscapes and air' },
      { id: 'Pastoral', label: 'Pastoral', desc: 'Idyllic woodwinds and acoustic strings evoking countryside calm' },
      { id: 'Industrial', label: 'Industrial', desc: 'Metallic percussion clangs, mechanical pulse, and dystopian grit' },
      { id: 'Romantic', label: 'Romantic', desc: 'Lush, passionate harmonies and sweeping melodic warmth' },
    ],
  },
];

export const VOCAL_CATEGORIES: TagCategory[] = [
  {
    id: 'voice',
    label: 'Type',
    desc: 'Lead vocalist identity, ensemble size, or harmony structure (select 1)',
    max: 1,
    tags: [
      { id: 'Female Vocal', label: 'Female Vocal', desc: 'Solo female lead vocal performance' },
      { id: 'Male Vocal', label: 'Male Vocal', desc: 'Solo male lead vocal performance' },
      { id: 'Duet', label: 'Duet', desc: 'Interplay and traded lines between two distinct lead vocalists' },
      { id: 'Choir', label: 'Choir', desc: 'Full multi-voice choral ensemble singing in unified harmony' },
      { id: 'Ethereal Choir', label: 'Ethereal Choir', desc: 'Angelic, reverb-washed choral voices floating above the mix' },
      { id: 'Gospel Choir', label: 'Gospel Choir', desc: 'Powerful, soulful multi-part gospel choir backing and swells' },
      { id: 'Call and Response', label: 'Call and Response', desc: 'Lead vocal phrases answered dynamically by backing voices' },
      { id: 'Backing Vocals', label: 'Backing Vocals', desc: 'Supportive harmony and counter-melody vocal layers' },
      { id: 'Layered Harmonies', label: 'Layered Harmonies', desc: 'Multi-tracked vocal stacks enriching the lead melody' },
      { id: 'Stacked Harmonies', label: 'Stacked Harmonies', desc: 'Dense, wall-of-vocals harmonic chord stacks on hooks' },
      { id: 'Vocal Sample', label: 'Vocal Sample', desc: 'Pitched or chopped vocal hook woven into the beat' },
      { id: 'Vocoder', label: 'Vocoder', desc: 'Robotic synthesizer-modulated vocal carrier harmony' },
    ],
  },
  {
    id: 'register',
    label: 'Register',
    desc: 'Vocal pitch range, tessitura, and resonance placement (select 1)',
    max: 1,
    tags: [
      { id: 'Soprano', label: 'Soprano', desc: 'Highest female vocal register with bell-like upper extension' },
      { id: 'Alto', label: 'Alto', desc: 'Warm, grounded lower female vocal register' },
      { id: 'Tenor', label: 'Tenor', desc: 'Bright, projecting higher male vocal register' },
      { id: 'Baritone', label: 'Baritone', desc: 'Rich, resonant mid-to-low male vocal register' },
      { id: 'Falsetto', label: 'Falsetto', desc: 'Airy, weightless upper-register vocal flip' },
      { id: 'High-Pitched', label: 'High-Pitched', desc: 'Elevated upper-octave vocal placement and brightness' },
      { id: 'Low-Pitched', label: 'Low-Pitched', desc: 'Deep, chest-resonant low-octave vocal foundation' },
      { id: 'Chest Voice', label: 'Chest Voice', desc: 'Grounded, full-bodied natural speaking-register power' },
      { id: 'Head-Voice', label: 'Head-Voice', desc: 'Focused, resonant upper-register tone without strain' },
      { id: 'Operatic', label: 'Operatic', desc: 'Classical conservatory projection with wide dynamic reach' },
      { id: 'Soaring', label: 'Soaring', desc: 'Sustained, high-reaching melodic lines that glide over the chorus' },
      { id: 'Pitched-Down', label: 'Pitched-Down', desc: 'Formant-shifted deep vocal effect for dark electronic or phonk hooks' },
    ],
  },
  {
    id: 'vocal_timbre',
    label: 'Timbre',
    desc: 'Tone color, breathiness, and surface texture of the voice (select 1)',
    max: 1,
    tags: [
      { id: 'Breathy', label: 'Breathy', desc: 'Intimate, air-rich vocal tone with close-mic warmth' },
      { id: 'Raspy Vocal', label: 'Raspy Vocal', desc: 'Weathered, gravelly vocal edge and rock/soul grit' },
      { id: 'Soulful', label: 'Soulful', desc: 'Rich, emotionally resonant tone steeped in R&B and gospel warmth' },
      { id: 'Clean Vocals', label: 'Clean Vocals', desc: 'Clear, uncolored melodic singing with crisp diction' },
      { id: 'Airy Pop Vocal', label: 'Airy Pop Vocal', desc: 'Bright, modern pop vocal sheen with delicate top-end breath' },
      { id: 'Warm Soulful Vocal', label: 'Warm Soulful Vocal', desc: 'Smooth, velvety low-mid vocal body with gentle vibrato' },
      { id: 'Silky Vocals', label: 'Silky Vocals', desc: 'Effortless, satin-smooth R&B vocal glide' },
      { id: 'Smooth Vocals', label: 'Smooth Vocals', desc: 'Even, mellow vocal tone without harsh sibilance' },
      { id: 'Polished Vocals', label: 'Polished Vocals', desc: 'Radio-ready, tightly tuned and compressed modern vocal finish' },
      { id: 'Raw Vocals', label: 'Raw Vocals', desc: 'Unfiltered, emotionally direct vocal take with natural grit' },
      { id: 'Twangy Vocals', label: 'Twangy Vocals', desc: 'Bright country and roots vocal inflection with forward nasal ring' },
      { id: 'Crooning Vocals', label: 'Crooning Vocals', desc: 'Warm, intimate jazz-standard baritone or lounge vocal style' },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    desc: 'Articulation, phrasing technique, and performance intensity (select 1)',
    max: 1,
    tags: [
      { id: 'Powerful Belting', label: 'Powerful Belting', desc: 'Full-throated, high-intensity chest-voice climax' },
      { id: 'Whispered', label: 'Whispered', desc: 'Hushed, close-mic ASMR-like vocal intimacy' },
      { id: 'Emotional Delivery', label: 'Emotional Delivery', desc: 'Dynamic, crack-in-the-voice expressive storytelling' },
      { id: 'Operatic Delivery', label: 'Operatic Delivery', desc: 'Classical legato projection with dramatic vibrato' },
      { id: 'Vibrato', label: 'Vibrato', desc: 'Warm, expressive pitch oscillation on sustained notes' },
      { id: 'Legato', label: 'Legato', desc: 'Smooth, connected note-to-note vocal phrasing' },
      { id: 'Staccato', label: 'Staccato', desc: 'Short, detached, percussive vocal articulation' },
      { id: 'Melodic Rap', label: 'Melodic Rap', desc: 'Sung-rapped cadence blending pitch contours with rhythmic flow' },
      { id: 'Spoken Word', label: 'Spoken Word', desc: 'Rhythmic poetic recitation or narrative monologue' },
      { id: 'Screamed Vocals', label: 'Screamed Vocals', desc: 'Aggressive, high-distortion metal and hardcore vocal fry/scream' },
      { id: 'Rhythmic Vocals', label: 'Rhythmic Vocals', desc: 'Pocket-locked percussive cadence driving the beat' },
      { id: 'Ad-Lib', label: 'Ad-Lib', desc: 'Improvised vocal runs, shouts, and background embellishments' },
    ],
  },
];

export const STYLE_CATEGORIES: TagCategory[] = [...GENRE_CATEGORIES, ...PRODUCTION_CATEGORIES];

export const GENRE_TAGS = GENRE_CATEGORIES.flatMap(category => category.tags.map(tag => tag.id));
export const PRODUCTION_TAGS = PRODUCTION_CATEGORIES.flatMap(category => category.tags.map(tag => tag.id));
export const STYLE_TAGS = [...GENRE_TAGS, ...PRODUCTION_TAGS];
export const MOOD_TAGS = MOOD_CATEGORIES.flatMap(category => category.tags.map(tag => tag.id));
export const VOCAL_TAGS = VOCAL_CATEGORIES.flatMap(category => category.tags.map(tag => tag.id));
export const PROMPT_TAGS = STYLE_TAGS;

export function toTagSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PRODUCTION_SLUG_MAP = new Map<string, string>(
  PRODUCTION_TAGS.map(tag => [toTagSlug(tag), tag]),
);
const MOOD_SLUG_MAP = new Map<string, string>(
  MOOD_TAGS.map(tag => [toTagSlug(tag), tag]),
);
const VOCAL_SLUG_MAP = new Map<string, string>(
  VOCAL_TAGS.map(tag => [toTagSlug(tag), tag]),
);
const GENRE_SLUG_MAP = new Map<string, string>(
  GENRE_TAGS.map(tag => [toTagSlug(tag), tag]),
);

export const NON_GENRE_SLUGS = new Set<string>([
  ...PRODUCTION_SLUG_MAP.keys(),
  ...MOOD_SLUG_MAP.keys(),
  ...VOCAL_SLUG_MAP.keys(),
  'alt-mix',
  'uncategorized',
  'all',
]);

export function isNonGenreTag(raw: string): boolean {
  const slug = toTagSlug(raw);
  return !slug || NON_GENRE_SLUGS.has(slug);
}

export interface PartitionedSongTags {
  genres: string[];
  production: string[];
  mood: string[];
  vocal: string[];
  allConditioningTags: string[];
}

export function partitionSongTags(input: {
  genres?: readonly string[] | null;
  production?: readonly string[] | null;
  mood?: readonly string[] | null;
  vocal?: readonly string[] | null;
  tags?: readonly string[] | null;
  instrumental?: boolean;
}): PartitionedSongTags {
  const genres: string[] = [];
  const production: string[] = [];
  const mood: string[] = [];
  const vocal: string[] = [];

  const seenGenres = new Set<string>();
  const seenProduction = new Set<string>();
  const seenMood = new Set<string>();
  const seenVocal = new Set<string>();

  const addGenre = (raw: string) => {
    const trimmed = raw.trim();
    const slug = toTagSlug(trimmed);
    if (!slug || seenGenres.has(slug)) return;
    seenGenres.add(slug);
    genres.push(GENRE_SLUG_MAP.get(slug) ?? trimmed);
  };

  const addProduction = (raw: string) => {
    const trimmed = raw.trim();
    const slug = toTagSlug(trimmed);
    if (!slug || seenProduction.has(slug)) return;
    seenProduction.add(slug);
    production.push(PRODUCTION_SLUG_MAP.get(slug) ?? trimmed);
  };

  const addMood = (raw: string) => {
    const trimmed = raw.trim();
    const slug = toTagSlug(trimmed);
    if (!slug || seenMood.has(slug)) return;
    seenMood.add(slug);
    mood.push(MOOD_SLUG_MAP.get(slug) ?? trimmed);
  };

  const addVocal = (raw: string) => {
    if (input.instrumental) return;
    const trimmed = raw.trim();
    const slug = toTagSlug(trimmed);
    if (!slug || seenVocal.has(slug)) return;
    seenVocal.add(slug);
    vocal.push(VOCAL_SLUG_MAP.get(slug) ?? trimmed);
  };

  const classifyAndAdd = (raw: unknown, preferredCategory?: 'genres' | 'production' | 'mood' | 'vocal') => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    const slug = toTagSlug(trimmed);
    if (!slug || slug === 'alt-mix' || slug === 'uncategorized' || slug === 'all') return;

    if (PRODUCTION_SLUG_MAP.has(slug)) {
      addProduction(trimmed);
      return;
    }
    if (MOOD_SLUG_MAP.has(slug)) {
      addMood(trimmed);
      return;
    }
    if (VOCAL_SLUG_MAP.has(slug)) {
      addVocal(trimmed);
      return;
    }
    if (GENRE_SLUG_MAP.has(slug)) {
      addGenre(trimmed);
      return;
    }

    if (preferredCategory === 'production') {
      addProduction(trimmed);
    } else if (preferredCategory === 'mood') {
      addMood(trimmed);
    } else if (preferredCategory === 'vocal') {
      addVocal(trimmed);
    } else {
      addGenre(trimmed);
    }
  };

  if (Array.isArray(input.genres)) {
    for (const item of input.genres) classifyAndAdd(item, 'genres');
  }
  if (Array.isArray(input.production)) {
    for (const item of input.production) classifyAndAdd(item, 'production');
  }
  if (Array.isArray(input.mood)) {
    for (const item of input.mood) classifyAndAdd(item, 'mood');
  }
  if (!input.instrumental && Array.isArray(input.vocal)) {
    for (const item of input.vocal) classifyAndAdd(item, 'vocal');
  }
  if (Array.isArray(input.tags)) {
    for (const item of input.tags) classifyAndAdd(item);
  }

  const allConditioningTags: string[] = [];
  const seenAll = new Set<string>();
  for (const list of [genres, production, mood, vocal]) {
    for (const tag of list) {
      const slug = toTagSlug(tag);
      if (!slug || seenAll.has(slug)) continue;
      seenAll.add(slug);
      allConditioningTags.push(tag);
    }
  }

  return { genres, production, mood, vocal, allConditioningTags };
}

export const ROOT_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const SCALE_MODES = [
  { id: 'major', label: 'MAJOR', desc: 'Bright, resolved diatonic tonality' },
  { id: 'minor', label: 'MINOR', desc: 'Darker, expressive harmonic tonality' },
] as const;

export const TIME_SIGNATURES = [
  { id: '4', label: '4/4', desc: 'Common time — 4 quarter-note beats per bar' },
  { id: '3', label: '3/4', desc: 'Waltz meter — 3 quarter-note beats per bar' },
  { id: '6', label: '6/8', desc: 'Compound duple — swaying 6 eighth-note pulse' },
  { id: '2', label: '2/4', desc: 'Cut march meter — 2 driving beats per bar' },
] as const;

export const TEMPO_PRESETS = [
  { val: 80, label: '80 BPM', desc: 'Downtempo, ballad & lo-fi groove' },
  { val: 100, label: '100 BPM', desc: 'Mid-tempo R&B, hip-hop & pop pocket' },
  { val: 120, label: '120 BPM', desc: 'Classic pop, synthwave & disco pulse' },
  { val: 128, label: '128 BPM', desc: 'Club house, electro & festival drive' },
  { val: 140, label: '140 BPM', desc: 'Modern trap, dubstep & fast techno' },
  { val: 174, label: '174 BPM', desc: 'High-velocity drum and bass breakbeat' },
] as const;

export const DURATION_PRESETS = [
  { val: 30, label: '30s', desc: 'Short hook or intro sketch' },
  { val: 60, label: '60s', desc: 'Compact verse-chorus teaser' },
  { val: 90, label: '90s', desc: 'Concise single arrangement' },
  { val: 120, label: '120s', desc: 'Standard two-minute song structure' },
  { val: 180, label: '180s', desc: 'Full three-minute radio arrangement' },
  { val: 240, label: '240s', desc: 'Extended four-minute arrangement' },
  { val: 300, label: '300s', desc: 'Maximum five-minute epic progression' },
] as const;

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
