export const clean=(v:unknown,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
const norm=(v:string)=>v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function normalizeCompany(v:Record<string,unknown>,id:string){
 const c:any={id};
 for(const key of ['raisonSociale','denomination','siege','activite','ape','adresse','codePostal','ville','pays','telephone','portable','email','siteWeb','siret','contactNom','contactFonction','contactTelephone','contactEmail','acceptation'])c[key]=clean(v[key]);
 if(!c.raisonSociale)throw Error('La raison sociale est obligatoire.');
 if(/^\d{1,5}$/.test(c.codePostal))c.codePostal=c.codePostal.padStart(5,'0');
 c.siret=c.siret.replace(/\D/g,'');if(c.siret.length===13)c.siret=c.siret.padStart(14,'0');
 for(const key of ['metiers','secteurs'])c[key]=(Array.isArray(v[key])?(v[key] as unknown[]).map(x=>clean(x)):clean(v[key]).split(',').map(x=>x.trim())).filter(Boolean);
 if(!c.secteurs.length)c.secteurs=[c.activite||'À renseigner'];
 c.capacite=Number(v.capacite)>0?Number(v.capacite):null;
 c.lat=v.lat!==''&&v.lat!=null&&Number.isFinite(Number(v.lat))&&Math.abs(Number(v.lat))<=90?Number(v.lat):null;
 c.lon=v.lon!==''&&v.lon!=null&&Number.isFinite(Number(v.lon))&&Math.abs(Number(v.lon))<=180?Number(v.lon):null;
 c.geoPrecision=clean(v.geoPrecision)||null;
 return c;
}
export async function fingerprint(c:any){
 const text=c.siret.length===14?'siret:'+c.siret:[norm(c.raisonSociale),norm(c.adresse),c.codePostal,norm(c.ville)].join('|');
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
