import {createClient} from '@supabase/supabase-js';
export const supabaseUrl=import.meta.env.VITE_SUPABASE_URL || '';
export const publishableKey=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
export const configured=!!(supabaseUrl&&publishableKey);
export const supabase=configured?createClient(supabaseUrl,publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'pkce'}}):null;
export const asset=(name:string)=>new URL('./assets/'+name,document.baseURI).href;
let cachedState:{user:string;value:any}|null=null;
export async function request(path:string,body?:unknown){
 if(!supabase)throw Error('La connexion Supabase n’est pas encore configurée.');
 const {data:{session}}=await supabase.auth.getSession();
 if(cachedState?.user!==session?.user.id)cachedState=null;
 const stateRequest=path.split('?')[0]==='state'&&body===undefined;
 if(stateRequest&&cachedState)path+=(path.includes('?')?'&':'?')+'revision='+cachedState.value.revision;
 const headers:Record<string,string>={'Content-Type':'application/json','apikey':publishableKey};
 if(session)headers.Authorization='Bearer '+session.access_token;
 const response=await fetch(supabaseUrl+'/functions/v1/pfmp-api/'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
 const data=await response.json().catch(()=>({error:'Le service ne répond pas correctement.'}));
 if(!response.ok){if(response.status===401&&path!=='profile')window.dispatchEvent(new Event('pfmp-session-expired'));throw Error(data.error||'La demande n’a pas pu être effectuée.');}
 if(stateRequest&&data.unchanged&&cachedState)return cachedState.value;
 if(stateRequest&&session)cachedState={user:session.user.id,value:data};
 return data;
}
