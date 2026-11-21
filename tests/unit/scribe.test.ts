import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildAlignedLyrics,
  buildScribeLyrics,
  extractKeyterms,
  parseLyrics,
  prepareVocalStemWavForElevenLabs,
  readStoredAlignment,
  stripBracketedText,
  toPublicAlignment,
  type AlignmentChar,
} from '../../scribe/service.js';

function makeCharsFromText(text: string, stepSec = 0.08): AlignmentChar[] {
  const chars: AlignmentChar[] = [];
  for (let i = 0; i < text.length; i++) {
    const start = Number((1.0 + i * stepSec).toFixed(3));
    const end = Number((start + stepSec * 0.9).toFixed(3));
    chars.push({ text: text[i], start, end });
  }
  return chars;
}

test('parseLyrics separates bracketed effect tags from clean sung lines without regex and builds valid ElevenLabs keyterms', () => {
  const raw = `[Intro] [190 BPM] [blistering downstroke power chords]
[shouted] Why die chasing the antelope [echo]
Under the <copper> {sky} \\ tonight, running past the canyon rim!`;

  const parsed = parseLyrics(raw);
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.entries[0].isTagOnly, true);
  assert.deepEqual(parsed.entries[0].tags, ['Intro', '190 BPM', 'blistering downstroke power chords']);
  assert.equal(parsed.entries[1].isTagOnly, false);
  assert.equal(parsed.entries[1].sung, 'Why die chasing the antelope');
  assert.deepEqual(parsed.entries[1].tags, ['shouted', 'echo']);
  assert.equal(parsed.sungLines.length, 2);
  assert.equal(
    parsed.plainText,
    'Why die chasing the antelope\nUnder the <copper> {sky} \\ tonight, running past the canyon rim!'
  );

  // Keyterms strictly obey ElevenLabs limits: <= 5 words, <= 50 chars, zero forbidden chars (< > { } [ ] \)
  assert.equal(parsed.keyterms[0], 'Why die chasing the antelope');
  for (const term of parsed.keyterms) {
    assert.ok(term.length <= 50, `keyterm exceeds 50 chars: ${term}`);
    assert.ok(term.split(' ').length <= 5, `keyterm exceeds 5 words: ${term}`);
    assert.ok(!/[<>{}[\]\\]/.test(term), `keyterm contains forbidden char: ${term}`);
  }
  assert.equal(stripBracketedText('[whispered] Shadow [reverb] falls'), 'Shadow falls');
});

test('extractKeyterms deduplicates case-insensitively and splits long phrases safely within 50 chars', () => {
  const lines = [
    'Why die chasing the antelope',
    'why die chasing the antelope',
    'extraordinarily long lyrical phrase spanning well beyond fifty characters in a single line',
  ];
  const terms = extractKeyterms(lines);
  assert.equal(terms.filter((t) => t.toLowerCase() === 'why die chasing the antelope').length, 1);
  for (const term of terms) {
    assert.ok(term.length <= 50);
    assert.ok(term.split(' ').length <= 5);
  }
});

test('buildAlignedLyrics maps Cue character-level newlines onto exact songwriter lines and strips tags for public view', () => {
  const rawLyrics = `[Verse 1] [Intimate Vocal]
Why die chasing the antelope
Under the copper sky

[Chorus]
We run forever`;

  const parsed = parseLyrics(rawLyrics);
  const chars = makeCharsFromText(parsed.plainText, 0.05);
  const alignment = buildAlignedLyrics(parsed, chars);

  assert.ok(alignment);
  assert.equal(alignment.source, 'aligned');
  assert.equal(alignment.lines.length, 5);

  assert.equal(alignment.lines[0].text, '[Verse 1] [Intimate Vocal]');
  assert.equal(alignment.lines[0].isTag, true);
  assert.equal(alignment.lines[0].start, alignment.lines[1].start);

  assert.equal(alignment.lines[1].text, 'Why die chasing the antelope');
  assert.equal(alignment.lines[1].isTag, false);
  assert.deepEqual(
    alignment.lines[1].words.map((w) => w.text),
    ['Why', 'die', 'chasing', 'the', 'antelope']
  );

  assert.equal(alignment.lines[2].text, 'Under the copper sky');
  assert.equal(alignment.lines[3].text, '[Chorus]');
  assert.equal(alignment.lines[3].isTag, true);
  assert.equal(alignment.lines[3].start, alignment.lines[4].start);
  assert.equal(alignment.lines[4].text, 'We run forever');

  const publicOnly = toPublicAlignment(alignment);
  assert.ok(publicOnly);
  assert.equal(publicOnly.lines.length, 3);
  assert.deepEqual(
    publicOnly.lines.map((l) => l.text),
    ['Why die chasing the antelope', 'Under the copper sky', 'We run forever']
  );
  assert.ok(publicOnly.lines.every((l) => !l.isTag && !l.text.includes('[')));
});

test('buildScribeLyrics maps ElevenLabs segmented_json segments onto word timestamps without heuristics', () => {
  const segmentedJson = JSON.stringify({
    segments: [
      { text: 'Walking through the neon rain', start: 1.0, end: 3.1 },
      { text: 'Shadows call my name', start: 4.3, end: 6.1 },
    ],
  });
  const { lyrics, alignment } = buildScribeLyrics({
    text: 'Walking through the neon rain Shadows call my name',
    words: [
      { text: 'Walking', start: 1.0, end: 1.4, type: 'word' },
      { text: ' ', start: 1.4, end: 1.45, type: 'spacing' },
      { text: 'through', start: 1.45, end: 1.8, type: 'word' },
      { text: ' ', start: 1.8, end: 1.85, type: 'spacing' },
      { text: 'the', start: 1.85, end: 2.0, type: 'word' },
      { text: ' ', start: 2.0, end: 2.05, type: 'spacing' },
      { text: 'neon', start: 2.05, end: 2.5, type: 'word' },
      { text: ' ', start: 2.5, end: 2.55, type: 'spacing' },
      { text: 'rain', start: 2.55, end: 3.1, type: 'word' },
      { text: 'Shadows', start: 4.3, end: 4.8, type: 'word' },
      { text: ' ', start: 4.8, end: 4.85, type: 'spacing' },
      { text: 'call', start: 4.85, end: 5.2, type: 'word' },
      { text: ' ', start: 5.2, end: 5.25, type: 'spacing' },
      { text: 'my', start: 5.25, end: 5.5, type: 'word' },
      { text: ' ', start: 5.5, end: 5.55, type: 'spacing' },
      { text: 'name', start: 5.55, end: 6.1, type: 'word' },
    ],
    additional_formats: [
      { requested_format: 'segmented_json', content: segmentedJson, is_base64_encoded: false },
    ],
  });

  assert.equal(lyrics, 'Walking through the neon rain\nShadows call my name');
  assert.ok(alignment);
  assert.equal(alignment.source, 'scribe');
  assert.equal(alignment.lines.length, 2);
  assert.equal(alignment.lines[0].text, 'Walking through the neon rain');
  assert.equal(alignment.lines[0].start, 1.0);
  assert.equal(alignment.lines[0].end, 3.1);
  assert.equal(alignment.lines[1].text, 'Shadows call my name');
  assert.equal(alignment.lines[1].start, 4.3);
  assert.equal(alignment.lines[1].end, 6.1);
});

test('prepareVocalStemWavForElevenLabs downsamples 48kHz stereo 16-bit WAV to 16kHz mono preserving exact duration', () => {
  const sampleRate = 48000;
  const numChannels = 2;
  const durationSec = 2;
  const totalFrames = sampleRate * durationSec;
  const dataSize = totalFrames * numChannels * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * 2, 28);
  buf.writeUInt16LE(numChannels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  const downsampled = prepareVocalStemWavForElevenLabs(buf);
  assert.equal(downsampled.readUInt16LE(22), 1);
  assert.equal(downsampled.readUInt32LE(24), 16000);
  const outDataSize = downsampled.readUInt32LE(40);
  assert.equal(outDataSize / 2 / 16000, durationSec);
  assert.ok(downsampled.length < buf.length / 5);
});

test('readStoredAlignment extracts canonical alignment from active take provenance parameters', () => {
  const alignment = {
    source: 'aligned' as const,
    updatedAt: '2026-11-21T00:00:00.000Z',
    lines: [{ index: 0, text: 'Chasing the antelope', isTag: false, start: 13.58, end: 14.62, words: [] }],
    words: [],
  };
  const found = readStoredAlignment([
    {
      id: 't1',
      song_id: 's1',
      stem_id: null,
      take_number: 1,
      model: 'acestep',
      task: 'text2music',
      prompt: null,
      lyrics: 'Chasing the antelope',
      repainting_start: null,
      repainting_end: null,
      url: 'https://example.com/a.wav',
      waveform_url: null,
      is_active: true,
      seed: null,
      created_at: new Date(),
      provenance: {
        taskId: 'k1',
        sourceUrl: 'https://example.com/a.wav',
        sourceTakeId: null,
        sourceDuration: 180,
        target: 'master',
        targetStemId: null,
        region: null,
        outputDuration: 180,
        parameters: { lyricsAlignment: alignment },
      },
    },
  ]);
  assert.deepEqual(found, alignment);
});
