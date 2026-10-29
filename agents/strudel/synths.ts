export const SUPPORTED_OSCILLATORS = ['sawtooth', 'square', 'triangle', 'sine'] as const;

export const SUPPORTED_METHODS = [
  '.s("sawtooth" | "square" | "triangle" | "sine")',
  '.scale("Root:mode")',
  '.fast(n)',
  '.slow(n)',
  '.rev()',
  '.gain(0.0 .. 1.5)',
  '.lpf(100 .. 12000)',
  '.hpf(20 .. 4000)',
  '.pan(-1.0 .. 1.0)',
  '.room(0.0 .. 1.0)',
  '.delay(0.0 .. 0.9)',
] as const;

export const UNSUPPORTED_METHODS = [
  'crush', 'shape', 'distort', 'vowel', 'jux', 'every', 'sometimes', 'often', 'rarely',
  'off', 'arp', 'voicing', 'struct', 'mask', 'euclid', 'degrade', 'degradeBy', 'ply',
  'striate', 'chop', 'slice', 'splice', 'loopAt', 'hurry', 'iter', 'palindrome',
  'superimpose', 'layer', 'cat', 'seq', 'slowcat', 'fastcat', 'timeCat', 'polyrhythm',
] as const;

export const SYNTHS_LIBRARY = {
  oscillators: SUPPORTED_OSCILLATORS,
  methods: SUPPORTED_METHODS,
  unsupportedMethods: UNSUPPORTED_METHODS,
  mixRecipes: {
    bass: '.s("sawtooth").lpf(750).gain(0.75)',
    chords: '.s("triangle").lpf(1600).room(0.35).gain(0.45)',
    arp: '.s("sine").fast(2).hpf(800).delay(0.25).pan(0.25).gain(0.5)',
    drums: '.gain(0.85).room(0.15)',
  },
} as const;

export type SynthTargetRole = 'bass' | 'chords' | 'arp' | 'transform' | 'full';

/**
 * Compact, token-efficient summary of the Synth & DSP Modifiers library for Directed-Graph or ReAct injection.
 */
export function getSynthsLibraryContext(role: SynthTargetRole = 'full'): string {
  const lines = [
    '[SYNTHS & DSP LIBRARY]',
    '- Valid Modifiers: .s("sawtooth"|"square"|"triangle"|"sine"), .scale("Root:mode"), .fast(n), .slow(n), .rev(), .gain(0..1.5), .lpf(100..12000), .hpf(20..4000), .pan(-1..1), .room(0..1), .delay(0..0.9)',
  ];
  if (role === 'bass') {
    lines.push('- Bass Chain: .s("sawtooth"|"square").lpf(600..1100).gain(0.75)');
  } else if (role === 'chords') {
    lines.push('- Chords Chain: .s("triangle"|"sawtooth").lpf(1200..2200).room(0.35).gain(0.45)');
  } else if (role === 'arp') {
    lines.push('- Arp Chain: .s("sine"|"triangle").fast(2).hpf(700..1200).delay(0.25).pan(-0.3..0.3).gain(0.5)');
  } else if (role === 'transform') {
    lines.push('- Transform: Adjust filter/FX/timing on existing pattern while preserving valid note/drum tokens.');
  } else {
    lines.push('- Mix: drums .gain(0.85) | bass .s("sawtooth").lpf(850).gain(0.75) | chords .s("triangle").lpf(1600).room(0.35).gain(0.45) | arp .s("sine").hpf(800).delay(0.25).pan(0.3).gain(0.5)');
  }
  lines.push('- Forbidden: .every(), .jux(), .off(), .crush(), .shape(), .arp(), .voicing(), .struct(), .euclid(), cat().');
  return lines.join('\n');
}

export function cleanGeneratedStrudelCode(rawText: string): string {
  let cleaned = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  const fenceMatch = cleaned.match(/```(?:javascript|js|strudel|ts|tidal)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  } else {
    cleaned = cleaned
      .replace(/^```(?:javascript|js|strudel|ts)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  // Strip line comments and leading "$:" prefixes
  cleaned = cleaned
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\$[a-zA-Z0-9_]*\s*:\s*/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return cleaned;
}

export function validateGeneratedStrudelPattern(code: string): { valid: boolean; error?: string } {
  const trimmed = code.trim();
  if (!trimmed) {
    return { valid: false, error: 'Empty Strudel pattern' };
  }

  // Check balanced delimiters and quotes
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let brace = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const prev = i > 0 ? trimmed[i - 1] : '';
    if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;

    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '<') angle++;
    else if (ch === '>') angle--;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;

    if (paren < 0) return { valid: false, error: 'Unbalanced closing parenthesis ")"' };
    if (bracket < 0) return { valid: false, error: 'Unbalanced closing bracket "]"' };
    if (angle < 0) return { valid: false, error: 'Unbalanced closing angle bracket ">"' };
    if (brace < 0) return { valid: false, error: 'Unbalanced closing brace "}"' };
  }

  if (inSingle || inDouble) return { valid: false, error: 'Unclosed string literal quote' };
  if (paren !== 0) return { valid: false, error: 'Unbalanced parentheses "()"' };
  if (bracket !== 0) return { valid: false, error: 'Unbalanced square brackets "[]"' };
  if (angle !== 0) return { valid: false, error: 'Unbalanced angle brackets "<>"' };
  if (brace !== 0) return { valid: false, error: 'Unbalanced curly braces "{}"' };

  // Must contain at least one pattern generator call: s(...), sound(...), note(...), or n(...)
  const hasGenerator = /\b(?:s|sound|note|n)\s*\(\s*['"][^'"]+['"]\s*\)/.test(trimmed);
  if (!hasGenerator) {
    return {
      valid: false,
      error: 'Pattern must contain at least one s("..."), sound("..."), note("..."), or n("...") call with a non-empty mini-notation string',
    };
  }

  // Reject nested function calls inside note("...") or s("...") quotes (e.g. note("n(0 2 4).scale(...)"))
  if (/\b(?:s|sound|note|n)\s*\(\s*['"][^'"]*(?:\.scale\s*\(|\.s\s*\(|\bn\s*\(|\bnote\s*\()[^'"]*['"]\s*\)/i.test(trimmed)) {
    return {
      valid: false,
      error: 'Do not put n(...), .scale(...), or .s(...) inside a quoted string. Write n("0 2 4 6").scale("Root:mode").s("sine") as chained method calls.',
    };
  }

  // Reject chaining .s(...) onto a drum s("...") generator
  if (/\b(?:s|sound)\s*\(\s*['"][^'"]+['"]\s*\)\s*\.\s*(?:s|sound)\s*\(/i.test(trimmed)) {
    return {
      valid: false,
      error: 'Do not chain .s("...") onto a drum s("...") pattern. Only chain .s("sawtooth" | "square" | "triangle" | "sine") onto note("...") or n("...").',
    };
  }

  // Reject literal placeholder token x(k,n) in drum patterns
  if (/\bx\(\s*\d+\s*,\s*\d+/.test(trimmed)) {
    return {
      valid: false,
      error: 'Replace placeholder "x(k,n)" with a valid drum token such as hh(5,8,1), bd(3,8), cp(3,8,2), or perc(5,16).',
    };
  }

  // Reject space-separated <a a a a> <b b b b> where the model confused beat-level <...> with bar-level <...>
  if (/<[^>]+>\s+<[^>]+>\s+<[^>]+>\s+<[^>]+>/.test(trimmed)) {
    return {
      valid: false,
      error: 'To sequence a 4-bar progression across 4 cycles, use ONE outer angle-bracket group containing 4 bracketed bars: "<[bar1] [bar2] [bar3] [bar4]>", not 4 separate "<...> <...> <...> <...>" groups in the same bar.',
    };
  }

  // Check for unsupported chained methods that our local engine does not execute
  for (const method of UNSUPPORTED_METHODS) {
    const regex = new RegExp(`\\.${method.trim()}\\s*\\(`, 'i');
    if (regex.test(trimmed)) {
      return {
        valid: false,
        error: `Unsupported method .${method.trim()}() used. Use only supported Rawchunks Strudel methods: .s(), .scale(), .fast(), .slow(), .rev(), .gain(), .lpf(), .hpf(), .pan(), .room(), .delay().`,
      };
    }
  }

  // Ensure every layer line (outside stack( and )) begins with a valid pattern generator
  const codeLines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'));
  for (const line of codeLines) {
    if (/^stack\s*\($/i.test(line) || /^\)[,;]?$/.test(line)) continue;
    const withoutStackPrefix = line.replace(/^stack\s*\(\s*/i, '').trim();
    if (!withoutStackPrefix || /^\)[,;]?$/.test(withoutStackPrefix)) continue;
    if (!/^(?:s|sound|note|n)\s*\(/.test(withoutStackPrefix)) {
      return {
        valid: false,
        error: `Invalid expression "${withoutStackPrefix}". Every pattern layer must start with s("..."), sound("..."), note("..."), or n("...").`,
      };
    }
  }

  return { valid: true };
}
