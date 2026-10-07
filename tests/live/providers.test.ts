import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

const enabled=process.env.RAWCHUNKS_LIVE==='1';
describe.skipIf(!enabled)('bounded read-only live provider and infrastructure probes',()=>{
 beforeAll(async()=>{
  const actual=await vi.importActual<typeof import('dotenv')>('dotenv');
  Object.assign(process.env, actual.parse(readFileSync(new URL('../../.env',import.meta.url))));
 });
 it('API TLS health is reachable and an unrelated CORS origin is not reflected',async()=>{
  const res=await fetch('https://api.rawchunks.space/health',{signal:AbortSignal.timeout(10000),headers:{Origin:'https://attacker.invalid'}});
  expect(res.status).toBe(200);
  expect((await res.json() as any).status).toBe('healthy');
  expect(res.headers.get('access-control-allow-origin')).not.toBe('https://attacker.invalid');
 });
 it('R2 songs/versions/loras listing responds with valid success arrays',async()=>{
  for(const bucket of ['songs','versions','loras']){
   const res=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects`,{signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${process.env.CF_GLOBAL_TOKEN||process.env.CF_API_TOKEN}`}});
   expect(res.status,`R2 ${bucket} HTTP status`).toBe(200);
   const data=await res.json() as any;
   expect(data.success,`R2 ${bucket} success envelope`).toBe(true);
   expect(Array.isArray(data.result),`R2 ${bucket} array contract`).toBe(true);
  }
 },35000);
 it('Valkey accepts TLS-connected PING with certificate verification',async()=>{
  const connection=new Redis(process.env.VALKEY_REQUESTS_SERVICE_URI!,{lazyConnect:true,connectTimeout:10000,maxRetriesPerRequest:1,retryStrategy:()=>null,tls:{rejectUnauthorized:true}});
  connection.on('error',()=>{});
  try{await connection.connect();expect(await connection.ping()).toBe('PONG');expect(await connection.dbsize()).toBeGreaterThanOrEqual(0);}
  finally{connection.disconnect();}
 },15000);
 it.each(['SONG_DATABASE_URL','USER_DATABASE_URL'])('%s permits a bounded read-only metadata query',async key=>{
  const sql=neon(process.env[key]!,{fetchOptions:{signal:AbortSignal.timeout(10000)}});
  const rows=await sql`SELECT table_name,column_name,is_nullable,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`;
  expect(rows.length).toBeGreaterThan(0);
  console.info(JSON.stringify({database:key,columns:rows}));
 });
 it('live voices table permits sample-only cloned voice insertion according to nullable schema',async()=>{
  const sql=neon(process.env.SONG_DATABASE_URL!,{fetchOptions:{signal:AbortSignal.timeout(10000)}});
  const rows=await sql`SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='voices' AND column_name='url'`;
  expect(rows).toEqual([{is_nullable:'YES'}]);
 });
 it('captured cluster reports API availability and the existing GPU executor',()=>{
  const cluster=JSON.parse(readFileSync(new URL('../results/cluster.json',import.meta.url),'utf8'));
  const api=cluster.deployments.find((d:any)=>d.name==='api');
  const worker=cluster.deployments.find((d:any)=>d.name==='acestep-xl-15-turbo');
  expect(api.readyReplicas).toBe(api.replicas);
  expect(worker.replicas).toBe(1);
  expect(worker.readyReplicas).toBe(1);
  expect(cluster.nodes.some((node:any)=>node.ready==='True'&&Number(node.allocatable['nvidia.com/gpu'])>=1)).toBe(true);
 });
});
