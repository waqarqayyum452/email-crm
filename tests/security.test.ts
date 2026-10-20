import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Router } from '../server/http.js';
import { httpFixture } from './http-fixture.js';
import { config } from '../server/config.js';
import { encryptSecret,decryptSecret,hashPassword,verifyPassword } from '../server/lib/crypto.js';
import { isPublicAddress } from '../server/lib/mail-target.js';
import { sanitizeEmail } from '../server/lib/html.js';
import { csvCell,redact } from '../server/lib/util.js';
import { csrfProtect,permit } from '../server/auth.js';
import { settingsSchema,defaultSettings } from '../server/settings.js';
import { contactSchema } from '../server/contacts.js';
import { parseCsv,mapCsvRow,validateImportRow } from '../server/imports.js';

beforeAll(()=>{config.encryptionKey=Buffer.alloc(32,9).toString('base64');});
beforeEach(()=>{config.allowedOrigins='';});
describe('security protections',()=>{
  it('uses authenticated encryption and rejects tampering',()=>{const secret='not-a-real-mailbox-password';const ciphertext=encryptSecret(secret);expect(ciphertext).not.toContain(secret);expect(decryptSecret(ciphertext)).toBe(secret);const parts=ciphertext.split('.');parts[3]=Buffer.alloc(32).toString('base64');expect(()=>decryptSecret(parts.join('.'))).toThrow();});
  it('hashes with scrypt and validates passwords',async()=>{const hash=await hashPassword('local-test-password-1234');expect(hash).toMatch(/^scrypt\$/);expect(await verifyPassword('local-test-password-1234',hash)).toBe(true);expect(await verifyPassword('wrong',hash)).toBe(false);expect(await verifyPassword('anything','malformed')).toBe(false);});
  it.each(['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.3','169.254.169.254','0.0.0.0','::1','fc00::1','fe80::1','::ffff:127.0.0.1','224.0.0.1','192.0.2.1'] )('rejects internal/reserved destination %s',ip=>expect(isPublicAddress(ip)).toBe(false));
  it('allows public unicast addresses',()=>{expect(isPublicAddress('8.8.8.8')).toBe(true);expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);});
  it('removes active content and remote images from incoming previews',()=>{const clean=sanitizeEmail('<script>alert(1)</script><img src="https://tracker.example/pixel"><p onclick="x()">Hello<a href="javascript:alert(1)">click</a><iframe src="https://bad.example"></iframe></p>');expect(clean).not.toMatch(/script|<img|onclick|javascript|iframe/);expect(clean).toContain('Hello');});
  it('redacts structured secrets and escapes CSV formulas',()=>{expect(redact({smtp_password:'hidden',nested:{authorization:'hidden',label:'safe'}})).toEqual({smtp_password:'[REDACTED]',nested:{authorization:'[REDACTED]',label:'safe'}});for(const value of ['=CMD()','+SUM(A1)',' -1','@IMPORT','\t=1'])expect(csvCell(value)).toMatch(/^"'/);expect(csvCell('a"b')).toBe('"a""b"');});
  it('rejects missing CSRF tokens and unauthorized roles server-side',async()=>{const router=Router(),app=httpFixture({mounts:[[router]]});router.post('/csrf',csrfProtect,(_req,res)=>res.json({ok:true}));router.post('/role',(req,_res,next)=>{req.user={id:'x',name:'Member',email:'m@example.com',role:'member',permissions:[]};next();},permit('settings:write'),(_req,res)=>res.json({ok:true}));expect((await request(app).post('/csrf')).status).toBe(403);expect((await request(app).post('/role')).status).toBe(403);const token='a'.repeat(64);expect((await request(app).post('/csrf').set('Cookie','sdwe_csrf='+token).set('x-csrf-token',token)).status).toBe(200);expect((await request(app).post('/csrf').set('Cookie','sdwe_csrf='+token).set('x-csrf-token',token).set('Origin','https://evil.example')).status).toBe(403);});
});
describe('validated business configuration and import',()=>{
  it('starts paused at 20 / rolling day and restricts unsafe settings',()=>{expect(defaultSettings.paused).toBe(true);expect(defaultSettings.application_cap).toBe(20);expect(settingsSchema.safeParse({...defaultSettings,application_cap:101}).success).toBe(false);expect(settingsSchema.safeParse({...defaultSettings,min_interval_seconds:0}).success).toBe(false);expect(settingsSchema.safeParse({...defaultSettings,timezone:'invalid/zone'}).success).toBe(false);expect(settingsSchema.safeParse({...defaultSettings,sending_start:'18:00',sending_end:'09:00'}).success).toBe(false);});
  it('requires consent evidence and does not infer consent',()=>{expect(contactSchema.parse({email:' Person@Example.com ' .trim()}).consent_status).toBe('unknown');expect(contactSchema.safeParse({email:'x@example.com',consent_status:'opted_in'}).success).toBe(false);});
  it('validates strict CSV and explicit mapping',()=>{const csv='Email,Company,Notes\r\n"Person@Example.com","Acme, Inc.","Hello"';const {headers,records}=parseCsv(csv);const d=mapCsvRow(headers,records[0],{Email:'email',Company:'company_name',Notes:'notes'});expect(d.email).toBe('person@example.com');expect(d.company_name).toBe('Acme, Inc.');expect(d.consent_status).toBe('unknown');expect(()=>parseCsv('email,email\nx@example.com,x@example.com')).toThrow();expect(()=>parseCsv('email,name\nx@example.com')).toThrow();expect(()=>parseCsv('email\n"bad')).toThrow();});
  it('deduplicates, excludes suppression, and never treats a public address as consent',()=>{const seen=new Set<string>();const data={email:'x@example.com'};expect(validateImportRow(data,2,seen,new Set(),new Set()).status).toBe('valid');expect(validateImportRow(data,3,seen,new Set(),new Set()).status).toBe('duplicate');const excluded=validateImportRow({...data,consent_status:'opted_in',source:'CSV',consent_evidence:'Asserted'},4,new Set(),new Set(),new Set(['x@example.com']));expect(excluded.status).toBe('excluded');expect(validateImportRow({email:'invalid'},5,new Set(),new Set(),new Set()).status).toBe('invalid');});
});
