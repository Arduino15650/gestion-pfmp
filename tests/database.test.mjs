import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const T='10000000-0000-4000-8000-000000000001',A='10000000-0000-4000-8000-000000000002',B='10000000-0000-4000-8000-000000000003',X='10000000-0000-4000-8000-000000000004';
const sessions={[T]:'20000000-0000-4000-8000-000000000001',[A]:'20000000-0000-4000-8000-000000000002',[B]:'20000000-0000-4000-8000-000000000003',[X]:'20000000-0000-4000-8000-000000000004'};
const emails={[T]:'teacher@example.test',[A]:'alice@example.test',[B]:'benoit@example.test',[X]:'outside@example.test'};
async function rpc(action,body={},user=T,aal=user===T?'aal2':'aal1'){
 await db.exec('set role service_role');try{
 const r=await db.query('select public.pfmp_request($1,$2::jsonb,$3::uuid,$4,$5::uuid,$6) as result',[action,JSON.stringify(body),user,emails[user],sessions[user],aal]);return r.rows[0].result;
 }finally{await db.exec('reset role');}
}
const company=(id,n='Entreprise '+id)=>({id,raisonSociale:n,denomination:'',siret:'',fingerprint:id,adresse:'12 rue Exemple',codePostal:'75000',ville:'Paris',secteurs:['Électricité'],metiers:[],lat:48.8,lon:2.3});
before(async()=>{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid);');
 await db.exec(readFileSync(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
 for(const id of [T,A,B,X]){await db.query('insert into auth.users values($1,$2,now())',[id,emails[id]]);await db.query('insert into auth.sessions values($1,$2)',[sessions[id],id]);}
 await db.query('insert into public.pfmp_teachers(email) values($1)',[emails[T]]);
 await db.query("insert into public.pfmp_students(id,name,class_name,email,auth_user_id) values('alice','Alice Exemple','1MELEC',$1,$2),('benoit','Benoît Exemple','TMELEC',$3,$4)",[emails[A],A,emails[B],B]);
});
after(()=>db.close());

test('teacher MFA is enforced; unknown users cannot access data',async()=>{
 assert.equal((await rpc('profile',{},T,'aal1')).role,'teacher');
 await assert.rejects(rpc('state',{},T,'aal1'),/Authenticator/);
 await assert.rejects(rpc('state',{},X),/pas autorisé/);
 assert.equal((await rpc('state')).students.length,2);
});
test('browser roles cannot read tables or execute privileged RPCs',async()=>{
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  try{await assert.rejects(db.query('select * from public.pfmp_companies'),/permission denied/);await assert.rejects(db.query("select public.pfmp_request('state','{}',null,null,null,null)"),/permission denied/);}finally{await db.exec('reset role');}
 }
 const flags=await db.query("select relname,relrowsecurity from pg_class where relname like 'pfmp_%' and relkind='r'");assert.ok(flags.rows.every(t=>t.relrowsecurity));
});
test('student can only see own profile and cannot modify the catalogue or other pupils',async()=>{
 const state=await rpc('state',{},A);assert.deepEqual(state.students.map(x=>x.id),['alice']);assert.equal(state.students[0].auth_user_id,undefined);
 await assert.rejects(rpc('students',{name:'No',class_name:'X'},A),/réservée/);
 await assert.rejects(rpc('companies',{companies:[company('forbidden')]},A),/réservée/);
});
test('company import deduplicates and address changes invalidate old coordinates',async()=>{
 assert.equal((await rpc('companies',{companies:[company('c1'),company('c2')]})).added,2);
 const duplicate=await rpc('companies',{companies:[{...company('duplicate'),fingerprint:'c1'}]});assert.equal(duplicate.duplicates,1);
 const v=company('c2');v.adresse='Nouvelle adresse';await rpc('companies',{companies:[v]});const updated=(await rpc('state')).companies.find(x=>x.id==='c2');assert.equal(updated.lat,null);assert.equal(updated.lon,null);
});
test('acceptance reserves the company atomically and hides it from other pupils',async()=>{
 const accepted=await rpc('reports',{companyId:'c1',studentId:'alice',status:'Accepté',date:'2026-10-07',notes:'Contact réussi'},A);
 assert.ok(accepted.id);assert.equal((await rpc('state',{},A)).companies.some(c=>c.id==='c1'),true);assert.equal((await rpc('state',{},B)).companies.some(c=>c.id==='c1'),false);
 await assert.rejects(rpc('reports',{companyId:'c1',studentId:'benoit',status:'Accepté',date:'2026-10-07'},B),/déjà accepté/);
 await assert.rejects(rpc('reports',{companyId:'c2',studentId:'benoit',status:'En attente',date:'2026-10-07'},A),/inaccessible/);
 assert.equal((await rpc('state',{},B)).reports.length,0);
 await rpc('release',{companyId:'c1'});assert.equal((await rpc('state',{},B)).companies.some(c=>c.id==='c1'),true);
});
test('state revision avoids re-downloading the catalogue and changes after a write',async()=>{
 const state=await rpc('state');assert.equal((await rpc('state',{revision:state.revision})).unchanged,true);
 await rpc('companies',{companies:[company('c3')]});assert.ok(!(await rpc('state',{revision:state.revision})).unchanged);
});
test('deletion cascades reports and reservations and prevents reimport',async()=>{
 await rpc('reports',{companyId:'c3',studentId:'alice',status:'Accepté',date:'2026-10-07'},A);
 await assert.rejects(rpc('delete-companies',{ids:['c3'],confirm:'non'}),/Confirmez/);
 const removed=await rpc('delete-companies',{ids:['c3'],confirm:'SUPPRIMER'});assert.equal(removed.deleted,1);
 assert.equal((await rpc('state')).reports.some(r=>r.company_id==='c3'),false);
 assert.equal((await rpc('companies',{companies:[company('c3')]})).duplicates,1);
});
test('invitation claims are single-use, invalid attempts are rate limited, reset revokes old access',async()=>{
 const invited=await rpc('invite',{studentId:'alice',reset:true,codeHash:'test-hash'});assert.equal(invited.oldUser,A);
 await assert.rejects(rpc('state',{},A),/pas autorisé/);
 const uid='10000000-0000-4000-8000-000000000005';
 const claim=async(hash,user=uid)=>(await db.query('select public.pfmp_signup_claim($1,$2,$3) result',[emails[A],hash,user])).rows[0].result;
 for(let i=0;i<5;i++)assert.ok((await claim('bad')).error);assert.match((await claim('test-hash')).error,/Trop d’essais/);
 await rpc('invite',{studentId:'alice',codeHash:'renewed'});
 assert.equal((await claim('renewed')).studentId,'alice');assert.ok((await claim('renewed',X)).error);
 await db.query('insert into auth.users values($1,$2,now())',[uid,emails[A]]);
 assert.equal((await db.query('select public.pfmp_signup_finish($1,$2,true) result',[emails[A],uid])).rows[0].result,true);
 assert.ok((await claim('renewed')).error);
});
test('revoked Auth session is refused even with a formerly valid user',async()=>{
 await db.query('delete from auth.sessions where id=$1',[sessions[B]]);await assert.rejects(rpc('state',{},B),/Session expirée/);
});
