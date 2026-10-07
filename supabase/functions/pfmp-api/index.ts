import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import {normalizeCompany,fingerprint,clean} from './normalization.ts';
const url=Deno.env.get('SUPABASE_URL')!;
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
const allowedOrigins=new Set(['https://arduino15650.github.io','http://127.0.0.1:5173','http://localhost:5173']);
class HttpError extends Error{constructor(message:string,public status=400){super(message);}}
async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
function check(result:any){if(result.error){const code=result.error.code;throw new HttpError(code==='23505'?'Cette adresse ou entreprise est déjà utilisée, ou une PFMP vient d’être attribuée.':['28000','42501','P0001'].includes(code)?result.error.message:'La sauvegarde a échoué. Vérifiez les champs et réessayez.',code==='28000'?401:code==='42501'?403:code==='23505'?409:400);}return result.data;}
function claims(token:string){try{return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));}catch{throw new HttpError('Session non valide.',401);}}

Deno.serve(async(req:Request)=>{
 const origin=req.headers.get('origin')||'';
 const cors={'Access-Control-Allow-Origin':allowedOrigins.has(origin)?origin:'https://arduino15650.github.io','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Vary':'Origin','Cache-Control':'no-store'};
 const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json;charset=utf-8'}});
 if(origin&&!allowedOrigins.has(origin))return respond({error:'Origine non autorisée.'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 try{
  const target=new URL(req.url),action=target.pathname.split('/').at(-1)||'';
  if(!['GET','POST'].includes(req.method))throw new HttpError('Méthode non autorisée.',405);
  let body:any={};
  if(req.method==='POST'){
   if(Number(req.headers.get('content-length')||0)>3_000_000)throw new HttpError('Fichier trop volumineux.',413);
   const text=await req.text();if(text.length>3_000_000)throw new HttpError('Fichier trop volumineux.',413);
   try{body=JSON.parse(text);}catch{throw new HttpError('Données non valides.');}
   if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError('Données non valides.');
  }
  if(action==='register-student'&&req.method==='POST'){
   const email=clean(body.email).toLowerCase(),password=String(body.password||''),firstName=clean(body.firstName,80),lastName=clean(body.lastName,80),code=clean(body.code).replace(/[^A-Z0-9]/gi,'').toUpperCase();
   if(!firstName||!lastName||!email||password.length<12||password.length>128||code.length<12)throw new HttpError('Complétez votre prénom, nom, e-mail, code et un mot de passe d’au moins 12 caractères.');
   const uid=crypto.randomUUID();
   const claimed=check(await db.rpc('pfmp_signup_claim',{p_email:email,p_hash:await hash(code),p_user:uid}));
   if(claimed.error)throw new HttpError(claimed.error,403);
   let created=false;
   try{
    const {data,error}=await db.auth.admin.createUser({id:uid,email,password,email_confirm:true,user_metadata:{first_name:firstName,last_name:lastName}} as any);
    if(error||!data.user||data.user.id!==uid)throw new HttpError('La création du compte a échoué. Si cette adresse possède déjà un compte, contactez votre enseignant.');
    created=true;
    const finished=check(await db.rpc('pfmp_signup_finish',{p_email:email,p_user:uid,p_success:true}));
    if(!finished)throw new HttpError('Le code a été renouvelé. Demandez le nouveau code à votre enseignant.');
   }catch(error){
    if(created)await db.auth.admin.deleteUser(uid);
    await db.rpc('pfmp_signup_finish',{p_email:email,p_user:uid,p_success:false});throw error;
   }
   return respond({created:true});
  }
  // Public registration authenticates with a single-use invitation. Every other route verifies Auth.
  const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
  if(!token)throw new HttpError('Connectez-vous à votre espace.',401);
  const {data:{user},error:authError}=await db.auth.getUser(token);
  if(authError||!user||!user.email||!user.email_confirmed_at)throw new HttpError('Session expirée ou e-mail non confirmé.',401);
  const jwt=claims(token);if(jwt.sub!==user.id||!jwt.session_id)throw new HttpError('Session non valide.',401);
  const ctx={p_user:user.id,p_email:user.email.toLowerCase(),p_session:jwt.session_id,p_aal:jwt.aal||'aal1'};
  const rpc=async(name:string,data:any={})=>check(await db.rpc('pfmp_request',{...ctx,p_action:name,p_body:data}));
  if(action==='profile'&&req.method==='GET')return respond(await rpc('profile'));
  if(action==='state'&&req.method==='GET')return respond(await rpc('state',{revision:target.searchParams.get('revision')}));
  if(req.method!=='POST')throw new HttpError('Route inconnue.',404);
  // Reject unauthorized roles before normalizing a batch or calling third-party geocoding.
  const profile=await rpc('profile');
  if(profile.role==='teacher'&&jwt.aal!=='aal2')throw new HttpError('Validez Authenticator.',403);
  if(action!=='reports'&&profile.role!=='teacher')throw new HttpError('Action réservée à l’enseignant.',403);
  if(action==='companies'){
   const input=Array.isArray(body.companies)?body.companies:[body];if(input.length>500)throw new HttpError('Importez au maximum 500 entreprises à la fois.');
   const companies=await Promise.all(input.map(async(v:any)=>{const c=normalizeCompany(v,clean(v.id)||crypto.randomUUID());return {...c,fingerprint:await fingerprint(c)};}));
   return respond(await rpc(action,{companies}));
  }
  if(action==='students'&&Array.isArray(body.students)&&body.students.length>1000)throw new HttpError('Importez au maximum 1 000 élèves à la fois.');
  if(action==='invite'){
   const bytes=crypto.getRandomValues(new Uint8Array(12)),code=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
   const result=await rpc('invite',{studentId:clean(body.studentId),reset:body.reset===true,codeHash:await hash(code)});
   if(result.oldUser){const {error}=await db.auth.admin.deleteUser(result.oldUser);if(error&&error.status!==404)throw new HttpError('L’accès a été désactivé, mais sa suppression a échoué. Réessayez la réinitialisation.');}
   return respond({email:result.email,expires:result.expires,code:code.match(/.{1,6}/g)!.join('-'),reset:body.reset===true});
  }
  if(action==='geocode'){
   const ids=Array.isArray(body.ids)?body.ids.slice(0,20).map(String):[];
   const state=await rpc('state');let located=0,unresolved=0;
   for(const c of state.companies.filter((c:any)=>ids.includes(c.id))){
    if(!c.adresse||!c.ville){unresolved++;continue;}
    const query=new URL('https://data.geopf.fr/geocodage/search');query.searchParams.set('q',[c.adresse,c.codePostal,c.ville].join(' '));query.searchParams.set('limit','1');if(/^\d{5}$/.test(c.codePostal))query.searchParams.set('postcode',c.codePostal);
    try{const res=await fetch(query,{signal:AbortSignal.timeout(6000)});if(!res.ok){unresolved++;continue;}const data=await res.json(),feature=data.features?.[0];if(!feature||feature.properties.score<0.6){unresolved++;continue;}
     const updated={...c,lon:feature.geometry.coordinates[0],lat:feature.geometry.coordinates[1],geoPrecision:feature.properties.type,geoLabel:feature.properties.label,geoScore:feature.properties.score};
     await rpc('companies',{companies:[{...updated,fingerprint:await fingerprint(updated)}]});located++;
    }catch{unresolved++;}
   }
   return respond({located,unresolved});
  }
  if(['students','reports','release','delete-companies'].includes(action))return respond(await rpc(action,body));
  throw new HttpError('Route inconnue.',404);
 }catch(error){return respond({error:error instanceof HttpError?error.message:'Le service est temporairement indisponible.'},error instanceof HttpError?error.status:500);}
});
