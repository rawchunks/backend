import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Board } from '../../../app/src/components/daw/Board.js';
import { useDawStore, type Take, type DAWTrack } from '../../../app/src/lib/daw/store.js';

const require = createRequire(new URL('../../../app/package.json', import.meta.url));
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const initial = { ...useDawStore.getInitialState() };
const takes: Take[] = [
  { id: 'original', song_id: 'song', take_number: 1, model: 'base', task: 'text2music', url: 'original.wav', is_active: true, created_at: '2026-10-09T00:00:00Z' },
  { id: 'earlier', song_id: 'song', take_number: 2, model: 'base', task: 'extract', url: 'earlier.wav', is_active: false, created_at: '2026-10-09T00:00:01Z' },
  { id: 'later', song_id: 'song', take_number: 3, model: 'base', task: 'extract', url: 'later.wav', is_active: false, created_at: '2026-10-09T00:00:02Z' },
];

function render(selectedTrackId: string, tracks: DAWTrack[] = [], versions = takes) {
  Object.assign(useDawStore.getInitialState(), { takes: versions, tracks, duration: 60, selectedTrackId });
  return renderToStaticMarkup(createElement(Board, {
    song: { id: 'song', title: 'Song' }, selectedTrackId,
  }));
}

function selectedRows(html: string) {
  return [...html.matchAll(/class="board-row\s+([^"]*)"/g)].filter(match => match[1].split(/\s+/).includes('selected'));
}

afterEach(() => Object.assign(useDawStore.getInitialState(), initial));

describe('editor selection', () => {
  it('does not add a focus outline to the master or select extracted badges', () => {
    const html = render('master');
    expect(selectedRows(html)).toHaveLength(0);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(0);
  });

  it.each(['earlier', 'later', 'original'])('highlights only the focused take %s', selected => {
    const html = render(selected);
    expect(selectedRows(html)).toHaveLength(1);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    const number = takes.find(take => take.id === selected)!.take_number;
    expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>#${number}</button>`));
    expect(html.match(new RegExp(`TK#${number}</span>`, 'g'))).toHaveLength(1);
  });

  it('keeps extracted badges unselected when another lane has focus', () => {
    const html = render('drums');
    expect(selectedRows(html)).toHaveLength(0);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(0);
  });
});


describe('master lanes', () => {
  const stems = ['Vocals', 'Drums', 'Bass'].map((name, index) => ({
    id: `stem-${index}`, name, type: 'stem', color: '#00ffff',
    volume: 1, pan: 0, muted: false, solo: false,
    clips: [{ id: `clip-${index}`, name, url: `${name}.wav`, startTime: index * 5, duration: 20, offset: 0 }],
  } as DAWTrack));
  it('uses one master canvas for the collective waveform', () => {
    const master = render('master', stems).split('class="board-overlays"')[0];
    expect(master.match(/class="waveform-canvas"/g)).toHaveLength(1);
    expect(master).not.toContain('stem-clip-waveform-canvas');
    expect(master).not.toContain('board-master-stem');
  });
  it('omits the repeated song title and category names from the track headers', () => {
    const html = render('master');
    const master = html.slice(html.indexOf('class="board-row master'), html.indexOf('class="board-section-separator'));
    expect(master).not.toContain('board-track-name');
    expect(html).not.toContain('class="board-track-name">EXTRACT');
    expect(html).not.toContain('class="board-track-name">TEXT2MUSIC');
    expect(html).toContain('aria-label="Category: EXTRACT, Take #2"');
  });
  it('uses existing labels and highlights only the selected lane badge', () => {
    const html = render('stem-1', stems);
    expect(html).toContain('data-selected-lane="stem-1"');
    expect(selectedRows(html)).toHaveLength(1);
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(html).toContain('aria-label="Select Drums in master" aria-pressed="true"');
    expect(html).toContain('>DRU</button>');
    expect(html).toContain('>VOC</button>');
    expect(html).toContain('>BAS</button>');
  });
  it('offers extraction before stems exist and compacting afterward', () => {
    expect(render('master')).toContain('aria-label="Extract stems"');
    const html = render('master', stems);
    expect(html).toContain('aria-label="Compact waveform"');
    expect(html).not.toContain('aria-label="Extract stems"');
  });
  it('highlights the instruments together when the combined instrumental lane is selected', () => {
    const separated = ['Bass', 'Other', 'Instrumental', 'Vocals', 'Drums'].map((name, index) => ({
      ...stems[0], id: `lane-${index}`, name,
    }));
    const html = render('lane-2', separated);
    expect(html).toContain('data-highlighted-lanes="lane-0,lane-1,lane-4"');
    expect(html).toContain('aria-label="Select Instrumental in master" aria-pressed="true"');
  });
  it('places the selected lane first without changing the stored track order', () => {
    const html = render('stem-2', stems);
    const lanes = html.slice(html.indexOf('class="board-section-separator'));
    const names = [...lanes.matchAll(/class="board-track-name">([^<]*)<\/span>/g)].map(match => match[1]);
    expect(names.slice(0, 3)).toEqual(['Bass', 'Vocals', 'Drums']);
    expect(useDawStore.getInitialState().tracks).toEqual(stems);
  });
});

describe('instrument lane content', () => {
  const keys = {
    id: 'keys', name: 'Keys Synth', type: 'pianoroll', clips: [],
    pianoRollNotes: [{ id: 'c', pitch: 'C4', midi: 60, startTime: 4, duration: 2, velocity: .8 }],
  } as DAWTrack;
  const drums = {
    id: 'drums', name: 'Drum Machine', type: 'sequencer', clips: [],
    sequencerVoices: [{ name: 'KICK', steps: [true, false], velocity: [.8, .8], muted: false }],
  } as DAWTrack;

  it('renders notes and drum hits on lanes without audio clips', () => {
    const html = render('master', [keys, drums]);
    expect(html).toContain('aria-label="Keys Synth notes"');
    expect(html).toContain('<title>C4</title>');
    expect(html).toContain('aria-label="Drum Machine notes"');
    expect(html).toContain('<title>KICK</title>');
    expect(html.match(/<pattern /g)).toHaveLength(2);
  });

  it('reflects edits and clears without changing the audio lanes', () => {
    const edited = { ...keys, pianoRollNotes: [{ ...keys.pianoRollNotes![0], pitch: 'E4', midi: 64 }] };
    const html = render('keys', [edited, { ...drums, sequencerVoices: [] }]);
    expect(html).toContain('<title>E4</title>');
    expect(html).not.toContain('<title>C4</title>');
    expect(html).not.toContain('<title>KICK</title>');
  });
});

describe('take mounting controls', () => {
  it('removes committed sections from Extracted while retaining pending takes and its accurate count', () => {
    const committed = {...takes[1],is_active:true,provenance:{target:'master',region:{start:0,end:5}}};
    const consumed = {...takes[0],is_active:false,provenance:{mergedInto:'merged'}};
    const baseline = {...takes[0],id:'merged',task:'merge',is_active:true};
    const master = {id:'master',type:'audio',clips:[{url:committed.url}]} as DAWTrack;
    const html = render('master',[master],[committed,consumed,baseline,takes[2]]);
    const extracted = html.slice(html.indexOf('<span>EXTRACTED</span>'));
    expect(extracted).not.toContain('Category: EXTRACT, Take #2');
    expect(extracted).not.toContain('Category: TEXT2MUSIC');
    expect(extracted).toContain('Category: EXTRACT, Take #3');
    expect(extracted).toContain('class="board-section-badge">1 TAKES</span>');
  });
  it('keeps mounted takes in Extracted without adding duplicate lane rows', () => {
    const track = { id: 'earlier', activeTakeId: 'earlier', name: 'Take #2', type: 'sample', muted: false, clips: [{ url: 'earlier.wav' }] } as DAWTrack;
    const html = render('master', [track]);
    expect(html).toContain('aria-label="Unmount Take #2" aria-pressed="true"');
    expect(html).not.toContain('class="board-track-name">Take #2</span>');
  });

  it('keeps saved instrument lanes visible when they store an active take ID', () => {
    const track = { id: 'bass', activeTakeId: 'earlier', name: 'Bass', type: 'stem', muted: false, clips: [{ url: 'bass.wav' }] } as DAWTrack;
    expect(render('master', [track])).toContain('class="board-track-name">Bass</span>');
  });

  it('places mounted waveforms and their controls inside the master timeline', () => {
    const track = { id: 'earlier', activeTakeId: 'earlier', name: 'Take #2', type: 'sample', muted: false,
      clips: [{id:'segment', url:'earlier.wav', startTime:10, offset:0, duration:5}] } as DAWTrack;
    const html = render('earlier', [track]);
    const master = html.slice(html.indexOf('class="board-row master'), html.indexOf('class="board-section-separator'));
    expect(master).toContain('aria-label="Toggle Take #2 in master" aria-pressed="true"');
    expect(master).toContain('aria-label="Select Take #2 section" aria-pressed="true"');
    expect(master).toContain('left:16.666666666666664%;width:8.333333333333332%');
    expect(master).toContain('aria-label="Toggle original section" aria-pressed="true"');
    const actions = master.slice(master.indexOf('class="board-overlay-actions"'));
    expect(actions).toContain('aria-label="Toggle original section"');
    expect(actions).toContain('aria-label="Toggle Take #2 section" aria-pressed="true"');
    expect(actions).toContain('class="board-overlay-player"');
    expect(actions).toContain('aria-label="Play selected audio for Take #2"');
    const badges = master.slice(master.indexOf('aria-label="Mounted layer controls"'),master.indexOf('class="board-track-header-bottom"'));
    expect(badges).not.toContain('>ORG</button>');
    expect(master).toContain('aria-label="Merge Take #2"');
    expect(master).toContain('aria-label="Merge all mounted sections"');
    expect(master).toContain('aria-label="Discard Take #2"');
    expect(master).toContain('aria-label="Reset Take #2 position"');
    expect(master).toContain('aria-label="Mounted layer controls"');
    expect(master).not.toContain(' dimmed');
  });

  it('does not dim instrument lanes when a mounted master layer is selected', () => {
    const lane = { id:'vocals',name:'Vocals',type:'stem',muted:false,solo:false,clips:[{url:'vocals.wav',startTime:0,duration:60}] } as DAWTrack;
    const layer = { ...lane,id:'earlier',activeTakeId:'earlier',type:'sample',clips:[{url:'part.wav',startTime:10,duration:5}] } as DAWTrack;
    const html = render('earlier',[lane,layer]);
    expect(html).not.toMatch(/data-track-id="vocals" class="[^"]*dimmed/);
  });

  it('keeps range handles accessible when a layer covers the selected interval', () => {
    Object.assign(useDawStore.getInitialState(), { selection: { start: 10, end: 15 } });
    const track = { id:'earlier',activeTakeId:'earlier',type:'sample',clips:[{id:'part',url:'part.wav',startTime:10,duration:5,offset:0}] } as DAWTrack;
    const html = render('earlier',[track]);
    expect(html).toContain('aria-label="Selection start"');
    expect(html).toContain('aria-label="Selection end"');
    expect(html).toContain('aria-label="Move selection"');
    expect(html).toContain('class="waveform-selection"');
  });

  it('shows a muted mounted section while disabling individual merge', () => {
    const track = { id: 'earlier', activeTakeId: 'earlier', type: 'sample', muted: true,
      clips: [{id:'segment', url:'earlier.wav', startTime:0, offset:0, duration:1}] } as DAWTrack;
    const html = render('earlier', [track]);
    expect(html).toContain('aria-label="Toggle Take #2 in master" aria-pressed="false"');
    expect(html).toContain('aria-label="Merge Take #2" disabled=""');
  });

  it('renders unmounted extend takes visibly in Extracted without expanding Master, and expands Master when mounted', () => {
    const extendTake: Take = {
      id: 'ext-take', song_id: 'song', take_number: 4, model: 'base', task: 'extend',
      url: 'ext.wav', is_active: false, created_at: '2026-10-09T00:00:03Z',
      repainting_start: 60, repainting_end: 90,
      provenance: { target: 'master', region: { start: 60, end: 90 }, outputDuration: 90 },
    };
    const unmountedHtml = render('master', [], [...takes, extendTake]);
    const extracted = unmountedHtml.slice(unmountedHtml.indexOf('<span>EXTRACTED</span>'));
    expect(extracted).toContain('Category: EXTEND, Take #4');
    // Unmounted extend row scales by Math.max(totalDuration=60, takeRange.end=90) = 90 => left:66.666%, width:33.333% (not left:100%)
    expect(extracted).toContain('left:66.66666666666666%;width:33.33333333333333%');

    // When mounted on Master, totalDuration expands to 90s and the extend overlay is placed at [60, 90] in Master
    const mountedTrack = {
      id: 'ext-take', activeTakeId: 'ext-take', name: 'Take #4', type: 'sample', muted: false,
      clips: [{ id: 'ext-clip', name: 'Take #4', url: 'ext.wav', startTime: 60, offset: 60, duration: 30 }],
    } as DAWTrack;
    const mountedHtml = render('ext-take', [mountedTrack], [...takes, extendTake]);
    const master = mountedHtml.slice(mountedHtml.indexOf('class="board-row master'), mountedHtml.indexOf('class="board-section-separator'));
    expect(master).toContain('aria-label="Select Take #4 section" aria-pressed="true"');
    expect(master).toContain('left:66.66666666666666%;width:33.33333333333333%');
    expect(master).toContain('aria-label="Merge Take #4"');
    expect(master).toContain('aria-label="Discard Take #4"');
  });
});
