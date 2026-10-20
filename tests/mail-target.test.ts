import { beforeEach,describe,expect,it,vi } from 'vitest';
const {resolve}=vi.hoisted(()=>({resolve:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:resolve}));
import { validateMailTarget } from '../server/lib/mail-target.js';
describe('mail connection SSRF boundary',()=>{
  beforeEach(()=>{resolve.mockReset();});
  it('pins a public address while preserving the TLS certificate hostname',async()=>{resolve.mockResolvedValue([{address:'8.8.8.8',family:4}]);expect(await validateMailTarget('smtp.example.com',465,'smtp')).toEqual({address:'8.8.8.8',family:4,servername:'smtp.example.com'});});
  it('rejects a mixed public/private DNS answer rather than selecting the public entry',async()=>{resolve.mockResolvedValue([{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);await expect(validateMailTarget('mail.example.com',993,'imap')).rejects.toThrow(/Private/);});
  it('limits mail protocols and ports before resolving a target',async()=>{await expect(validateMailTarget('mail.example.com',443,'smtp')).rejects.toThrow(/Only SMTP/);expect(resolve).not.toHaveBeenCalled();});
  it('blocks IP literals, URL syntax and local suffixes before DNS',async()=>{for(const host of ['127.0.0.1','host.local','user@example.com','https://example.com','mail.internal'])await expect(validateMailTarget(host,465,'smtp')).rejects.toThrow(/public/);expect(resolve).not.toHaveBeenCalled();});
  it('fails closed on unresolved mail hosts',async()=>{resolve.mockRejectedValue(new Error('untrusted resolver detail'));await expect(validateMailTarget('mail.example.com',465,'smtp')).rejects.toThrow('Mail server could not be resolved.');});
});
