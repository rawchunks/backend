import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
it('captured worker sources match their recorded deployed-source hashes',()=>{
 const base=new URL('../fixtures/worker/',import.meta.url);
 const provenance=JSON.parse(readFileSync(new URL('provenance.json',base),'utf8'));
 for(const [source,hash] of Object.entries(provenance.files)){
  const file=source.split('/').at(-1)!;
  expect(createHash('sha256').update(readFileSync(new URL(file,base))).digest('hex'),source).toBe(hash);
 }
});
