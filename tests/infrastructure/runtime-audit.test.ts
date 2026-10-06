import { describe,it,expect } from 'vitest';
import { readFileSync,existsSync } from 'node:fs';
const location=new URL('../results/runtime-dependency-audit.json',import.meta.url);
describe.skipIf(!existsSync(location))('captured runtime dependency audit production gate',()=>{
 it('has no known high or critical production dependency advisories',()=>{
  const audit=JSON.parse(readFileSync(location,'utf8'));
  expect(audit.metadata.vulnerabilities.high).toBe(0);
  expect(audit.metadata.vulnerabilities.critical).toBe(0);
 });
});
