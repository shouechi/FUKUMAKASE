import {createHmac,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest,type Server} from 'node:http';
import {afterAll,beforeAll,describe,expect,test} from 'vitest';
import {createApp,defaultClients} from '../../apps/api/src/app';
import {jstDate} from '../../packages/domain/src/index';

// Public fake fixture credentials. Never connect this test to a remote project.
const base='http://127.0.0.1:54337';
const secret='outfit-local-integration-fake-key-never-use-in-production';
function jwt(role:string,extra:Record<string,unknown>={}){
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const data=encode({alg:'HS256',typ:'JWT'})+'.'+encode({role,iss:base+'/auth/v1',aud:'authenticated',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...extra});
  return data+'.'+createHmac('sha256',secret).update(data).digest('base64url');
}
const anon=jwt('anon'),service=jwt('service_role');
const client=(token:string)=>defaultClients({SUPABASE_URL:base,SUPABASE_ANON_KEY:token,SUPABASE_SERVICE_ROLE_KEY:service} as any,token).user;
const admin=client(service),app=createApp();
const env={SUPABASE_URL:base,SUPABASE_ANON_KEY:anon,SUPABASE_SERVICE_ROLE_KEY:service} as any;
const credentials:Array<{id:string;token:string}>=[];
let server:Server;
async function call(user:number,path:string,method='GET',data?:unknown,requestKey=randomUUID()){
  return fetch(base+path,{method,headers:{Authorization:`Bearer ${credentials[user].token}`,'Content-Type':'application/json','Idempotency-Key':requestKey},...(data===undefined?{}:{body:JSON.stringify(data)})});
}
async function rpc(name:string,args:Record<string,unknown>){
  const result=await admin.rpc(name,args);if(result.error)throw new Error(`${name}: ${result.error.message}`);return result.data;
}
describe.skipIf(process.env.RUN_LOCAL_HTTP_INTEGRATION!=='1')('real local GoTrue + PostgREST + application migration HTTP integration',()=>{
  beforeAll(async()=>{
    server=createServer(async(request,response)=>{
      if(request.url?.startsWith('/api/')){
        try{
          const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
          const body=Buffer.concat(chunks),headers=new Headers();
          for(const [key,value] of Object.entries(request.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
          const result=await app.fetch(new Request(base+request.url,{method:request.method,headers,...(body.length?{body}: {})}),env);
          response.writeHead(result.status,Object.fromEntries(result.headers.entries()));response.end(Buffer.from(await result.arrayBuffer()));
        }catch{response.writeHead(502).end();}
        return;
      }
      const auth=request.url?.startsWith('/auth/v1');
      const prefix=auth?'/auth/v1':'/rest/v1';
      if(!request.url?.startsWith(prefix)){response.writeHead(404).end();return;}
      const upstream=httpRequest({hostname:'127.0.0.1',port:auth?54338:54339,path:request.url.slice(prefix.length)||'/',method:request.method,headers:request.headers},result=>{
        response.writeHead(result.statusCode??502,result.headers);result.pipe(response);
      });
      upstream.on('error',()=>response.writeHead(502).end());request.pipe(upstream);
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(54337,'127.0.0.1',resolve);});
    for(let n=0;n<2;n++){
      const email=`fixture-${randomUUID()}@example.test`,password='Local-fixture-password-82!';
      const created=await admin.auth.admin.createUser({email,password,email_confirm:true});
      if(created.error)throw new Error(created.error.message);
      const signed=await client(anon).auth.signInWithPassword({email,password});
      if(signed.error)throw new Error(signed.error.message);
      credentials.push({id:created.data.user.id,token:signed.data.session!.access_token});
      const response=await call(n,'/api/me/preferences');
      expect(response.status,JSON.stringify(await response.json())).toBe(200);
    }
  });
  afterAll(async()=>{
    for(const user of credentials)await admin.auth.admin.deleteUser(user.id);
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  test('GoTrue password login issues valid sessions while tampered and expired tokens are rejected',async()=>{
    expect((await call(0,'/api/me/preferences')).status).toBe(200);
    for(const token of [credentials[0].token.slice(0,-8)+'tampered',jwt('authenticated',{sub:credentials[0].id,exp:1})]){
      const result=await fetch(base+'/api/me/preferences',{headers:{Authorization:`Bearer ${token}`}});
      expect(result.status).toBe(401);
    }
  });
  test('RLS applies actual JWT claims and sensitive RPCs cannot be invoked by authenticated users',async()=>{
    const user=client(credentials[0].token);
    const own=await user.from('profiles').select('user_id');
    expect(own.error).toBeNull();expect(own.data).toEqual([{user_id:credentials[0].id}]);
    const other=await user.from('profiles').select('user_id').eq('user_id',credentials[1].id);
    expect(other.data).toEqual([]);
    expect((await user.rpc('reserve_upload',{p_user_id:credentials[1].id,p_request_key:randomUUID()})).error).not.toBeNull();
    expect((await user.from('maintenance_state').select('*')).error).not.toBeNull();
  });
  test('onboarding-only update and nested day override round-trip through real PostgREST',async()=>{
    const onboarding=await call(0,'/api/me/preferences','PATCH',{onboarding_completed:true});
    expect(onboarding.status,JSON.stringify(await onboarding.clone().json())).toBe(200);
    expect(await onboarding.json()).toMatchObject({onboarding_completed:true});
    const date=jstDate();
    const saved=await call(0,`/api/me/day-overrides/${date}`,'PUT',{is_workday:true,occasion:'external_visit',mood:'きれいめ'});
    expect(saved.status,JSON.stringify(await saved.clone().json())).toBe(200);
    expect(await (await call(0,`/api/me/day-overrides/${date}`)).json()).toMatchObject({override:{occasion:'external_visit',mood:'きれいめ'}});
  });
  test('real HTTP plan joins, confirmation retry, laundry and immutable count updates work end-to-end',async()=>{
    const clothes:any[]=[];
    for(const category of ['top','bottom']){
      const grant=await rpc('reserve_upload',{p_user_id:credentials[0].id,p_request_key:randomUUID()});
      clothes.push(await rpc('create_clothes',{p_user_id:credentials[0].id,p_request_key:randomUUID(),p_data:{image_key:grant.image_key,category,subtype:category==='top'?'shirt':'slacks',color:'white',seasons:['spring','summer','autumn','winter'],wear_limit:2,classification_state:'manual'}}));
    }
    const date=jstDate(),saved=await call(0,`/api/plans/${date}`,'PUT',{items:clothes.map(c=>({clothes_id:c.id,slot:c.category}))});
    expect(saved.status,JSON.stringify(await saved.clone().json())).toBe(200);
    const plan=await saved.json();expect(plan.items).toHaveLength(2);
    const key=randomUUID(),body={target_date:date,outfit_id:plan.outfit_id};
    const first=await call(0,'/api/wear-logs','POST',body,key),repeat=await call(0,'/api/wear-logs','POST',body,key);
    expect(first.status,JSON.stringify(await first.clone().json())).toBe(200);expect(await repeat.json()).toEqual(await first.json());
    const owned=await client(credentials[0].token).from('clothes').select('wears_since_wash').in('id',clothes.map(c=>c.id));
    expect(owned.error).toBeNull();expect(owned.data).toEqual([{wears_since_wash:1},{wears_since_wash:1}]);
    const washed=await call(0,`/api/clothes/${clothes[0].id}/washed`,'POST',{});
    expect(washed.status).toBe(200);expect(await washed.json()).toMatchObject({wears_since_wash:0});
  });
  test('tombstone immediately blocks valid sessions and Auth deletion blocks the still-unexpired JWT',async()=>{
    const job=await rpc('begin_deletion',{p_user_id:credentials[1].id});
    expect((await call(1,'/api/me/preferences')).status).toBe(403);
    expect((await client(credentials[1].token).from('profiles').select('*')).data).toEqual([]);
    expect((await admin.auth.admin.deleteUser(credentials[1].id)).error).toBeNull();
    expect((await call(1,'/api/me/preferences')).status).toBe(401);
    const leased=await rpc('lease_job',{p_id:job.id});
    expect(await rpc('finish_deletion',{p_id:job.id,p_lease_token:leased.lease_token})).toBe(true);
    const receipt=await admin.from('generation_jobs').select('user_id,status,payload,dedupe_key').eq('id',job.id).single();
    expect(receipt.data).toEqual({user_id:null,status:'completed',payload:{},dedupe_key:`deleted:${job.id}`});
  });
});
