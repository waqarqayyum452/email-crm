import { Router } from './http.js';
import { randomBytes } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { db, json } from './db.js';
import { requireUser, permit } from './auth.js';
import { contactSchema, insertContact, validateContactReferences, type ContactInput } from './contacts.js';
import { HttpError, sha256, normalizeEmail, audit, id, csvRows } from './lib/util.js';
import { getSettings } from './settings.js';

const baseFields=['first_name','last_name','email','company_name','website','phone','city','industry','tags','notes','source','consent_status','consent_evidence'];
const synonyms:Record<string,string>={first_name:'first_name',firstname:'first_name',last_name:'last_name',lastname:'last_name',email:'email',email_address:'email',company:'company_name',company_name:'company_name',website:'website',phone:'phone',city:'city',industry:'industry',category:'industry',tags:'tags',notes:'notes',contact_source:'source',source:'source',consent_status:'consent_status',consent_evidence:'consent_evidence'};
export type ImportRow={row:number;status:'valid'|'duplicate'|'invalid'|'excluded';errors:string[];data:Record<string,any>};
export function parseCsv(csv:string) {
  if(Buffer.byteLength(csv,'utf8')>2*1024*1024)throw new HttpError(400,'CSV limit is 2 MB.');
  if(csv.includes('\0'))throw new HttpError(400,'CSV contains unsupported null bytes.');
  let records:string[][];try{records=parse(csv,{bom:true,skip_empty_lines:true,relax_column_count:false,max_record_size:100000,trim:true});}catch{throw new HttpError(400,'Malformed CSV. Check quoting and column counts.');}
  if(records.length<2)throw new HttpError(400,'Include a header and at least one data row.');if(records.length>1001)throw new HttpError(400,'Import at most 1,000 rows at a time.');
  const headers=records[0];if(headers.length>100||headers.some(h=>!h||h.length>100)||new Set(headers).size!==headers.length)throw new HttpError(400,'Use unique, nonempty column names (maximum 100 columns).');
  return {headers,records:records.slice(1)};
}
export function mapCsvRow(headers:string[],values:string[],mapping:Record<string,string>,customDefinitions:{key:string;type:string}[]=[]) {
  const data:Record<string,any>={custom_fields:{}};
  for(let i=0;i<headers.length;i++){const field=mapping[headers[i]];if(!field||field==='ignore')continue;const value=values[i]||'';if(field.startsWith('custom:')){const key=field.slice(7),definition=customDefinitions.find(f=>f.key===key);data.custom_fields[key]=definition?.type==='number'&&value!==''?Number(value):value;}else if(field==='tags')data.tags=value.split(/[;|]/).map(t=>t.trim()).filter(Boolean);else data[field]=value;}
  if(data.email)data.email=normalizeEmail(data.email);if(!data.consent_status)data.consent_status='unknown';return data;
}
export function validateImportRow(data:Record<string,any>,row:number,seen:Set<string>,existing:Set<string>,suppressed:Set<string>):ImportRow {
  const {notes,...input}=data;const result=contactSchema.safeParse(input);
  if(!result.success)return{row,status:'invalid',errors:result.error.issues.map(e=>`${e.path.join('.')}: ${e.message}`),data};
  if(notes&&String(notes).length>20000)return{row,status:'invalid',errors:['notes: Maximum 20,000 characters.'],data};
  const email=result.data.email;
  if(suppressed.has(email))return{row,status:'excluded',errors:['Agency-wide suppression. Import cannot reactivate this address.'],data:{...result.data,notes:notes||''}};
  if(seen.has(email)||existing.has(email))return{row,status:'duplicate',errors:['Email already exists in this file or the CRM. Existing consent is preserved.'],data:{...result.data,notes:notes||''}};
  seen.add(email);return{row,status:'valid',errors:[],data:{...result.data,notes:notes||''}};
}
function countsFor(rows:ImportRow[]) {return {total:rows.length,valid:rows.filter(r=>r.status==='valid').length,duplicate:rows.filter(r=>r.status==='duplicate').length,invalid:rows.filter(r=>r.status==='invalid').length,excluded:rows.filter(r=>r.status==='excluded').length};}
export const importRouter=Router();importRouter.use(requireUser);
importRouter.post('/preview',permit('contacts:write'),async(req,res)=>{
  const body=z.object({csv:z.string().max(2*1024*1024),mapping:z.record(z.string().max(100)).optional()}).strict().parse(req.body);const {headers,records}=parseCsv(body.csv);const settings=await getSettings();
  const mapping=body.mapping||Object.fromEntries(headers.map(h=>[h,synonyms[h.toLowerCase().replace(/[^a-z0-9]/g,'_')]|| (settings.custom_fields.some(f=>f.key===h)?'custom:'+h:'ignore')]));
  const allowed=[...baseFields,...settings.custom_fields.map(f=>'custom:'+f.key),'ignore'];for(const [header,field] of Object.entries(mapping))if(!headers.includes(header)||!allowed.includes(field))throw new HttpError(400,'Invalid column mapping.');
  const mappedFields=Object.values(mapping).filter(f=>f&&f!=='ignore');if(new Set(mappedFields).size!==mappedFields.length)throw new HttpError(400,'Map each destination field once.');if(!mappedFields.includes('email'))throw new HttpError(400,'Map a column to email before previewing.');
  const data=records.map(row=>mapCsvRow(headers,row,mapping,settings.custom_fields));const emails=data.map(d=>String(d.email||''));const [present,blocked]=await Promise.all([db('contacts').whereIn('email',emails).select('email'),db('suppressions').whereIn('email',emails).select('email')]);const seen=new Set<string>(),existing=new Set(present.map(c=>c.email)),suppressed=new Set(blocked.map(c=>c.email));
  const rows=data.map((d,i)=>validateImportRow(d,i+2,seen,existing,suppressed));
  for(const row of rows.filter(r=>r.status==='valid'))try{const {notes,...c}=row.data;await validateContactReferences(c as ContactInput);}catch(err){row.status='invalid';row.errors=[err instanceof HttpError?err.message:'Invalid contact fields.'];}
  const token=randomBytes(32).toString('hex'),importId=id(),counts=countsFor(rows);await db('imports').insert({id:importId,user_id:req.user!.id,token_hash:sha256(token),rows:JSON.stringify(rows),counts:JSON.stringify(counts),expires_at:new Date(Date.now()+30*60000),created_at:new Date()});res.json({id:importId,headers,mapping,rows,counts,token});
});
importRouter.post('/confirm',permit('contacts:write'),async(req,res)=>{
  const {token}=z.object({token:z.string().regex(/^[a-f0-9]{64}$/)}).parse(req.body);
  const result=await db.transaction(async trx=>{
    const staged=await trx('imports').where({token_hash:sha256(token),user_id:req.user!.id}).forUpdate().first();if(!staged)throw new HttpError(404,'Import preview not found.');if(staged.confirmed_at)return {id:staged.id,...json(staged.counts,{})};if(new Date(staged.expires_at)<new Date())throw new HttpError(400,'Preview expired. Upload and validate the CSV again.');
    await trx('business_settings').where({id:'agency'}).forUpdate().first();const rows=json<ImportRow[]>(staged.rows,[]);const counts={imported:0,duplicate:0,invalid:0,excluded:0,total:rows.length};
    for(const row of rows){let status:string=row.status,error=row.errors.join('; ');if(row.status==='valid'){
      const {notes,...input}=row.data;const c=contactSchema.parse(input);if(await trx('suppressions').where({email:c.email}).first()){status='excluded';error='Suppressed since preview.';}
      else if(await trx('contacts').where({email:c.email}).first()){status='duplicate';error='Email already exists.';}
      else {try {await validateContactReferences(c,trx);}catch(err){status='invalid';error=err instanceof HttpError?err.message:'Invalid fields.';}
        if(status==='valid'){const saved=await insertContact(c,req.user!.id,trx);if(notes)await trx('notes').insert({id:id(),contact_id:saved.id,user_id:req.user!.id,body:notes,created_at:new Date()});status='imported';}}
    }else if(status==='valid')status='invalid';
      if(status in counts)(counts as any)[status]++;await trx('import_results').insert({id:id(),import_id:staged.id,row_number:row.row,status,email:row.data.email||null,error:error||null});
    }
    await trx('imports').where({id:staged.id}).update({confirmed_at:new Date(),counts:JSON.stringify(counts)});await audit(req.user!.id,'csv_import_confirmed','import',staged.id,counts,trx);return{id:staged.id,...counts};
  });res.json(result);
});
importRouter.get('/:id/errors.csv',async(req,res)=>{
  const item=await db('imports').where({id:req.params.id}).first();if(!item)throw new HttpError(404,'Import not found.');if(item.user_id!==req.user!.id&&req.user!.role!=='owner')throw new HttpError(403,'This import belongs to another user.');
  const rows=item.confirmed_at?(await db('import_results').where({import_id:item.id}).whereNot({status:'imported'}).orderBy('row_number')).map(r=>[r.row_number,r.email,r.status,r.error]):json<ImportRow[]>(item.rows,[]).filter(r=>r.status!=='valid').map(r=>[r.row,r.data.email,r.status,r.errors.join('; ')]);
  res.type('text/csv').set('Content-Disposition','attachment; filename="import-errors.csv"').send(csvRows([['row','email','status','error'],...rows]));
});
