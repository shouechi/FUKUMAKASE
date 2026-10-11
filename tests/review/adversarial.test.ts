import {describe,expect,test,vi} from 'vitest';
import {getForecasts} from '../../apps/api/src/providers';
import {generatePlans} from '../../apps/api/src/service';
import {createApp} from '../../apps/api/src/app';
import {addDays,planWarnings,recommend,seasonalWeather} from '../../packages/domain/src/index';
import {defaultPreferences,type Cloth} from '../../packages/schemas/src/index';
import {fakeDatabase} from '../helpers/fake-supabase';

const now=new Date('2026-10-19T00:00:00Z'),today='2026-10-19';
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('independent post-implementation adversarial review',()=>{
  test('manual plan warnings clear obsolete cold-weather warnings after the weather improves',()=>{
    const upper:Cloth={id:'11111111-1111-4111-8111-111111111111',category:'top',subtype:'shirt',color:'white',seasons:['autumn'],thickness:'normal',wear_limit:10,wears_since_wash:0,state:'available',classification_state:'manual'};
    const bottom:Cloth={...upper,id:'22222222-2222-4222-8222-222222222222',category:'bottom',subtype:'slacks'};
    const items=[upper,bottom].map(c=>({clothes_id:c.id,slot:c.category}));
    const warnings=planWarnings({target_date:today,mode:'manual_lock',source:'manual',plan_status:'proposed',items,reason_short:'自分で選んだ服',warnings:['気温が低いためアウターの追加をおすすめします']},{date:today,clothes:[upper,bottom],preferences:defaultPreferences,weather:{...seasonalWeather(today),min_c:22,max_c:28}});
    expect(warnings.join(' ')).not.toContain('気温が低い');
  });
  test('Japanese casual preference influences fallback even when AI classification metadata uses English subtypes',()=>{
    const shirt:Cloth={id:'11111111-1111-4111-8111-111111111111',category:'top',subtype:'shirt',color:'white',seasons:['autumn'],thickness:'normal',wear_limit:10,wears_since_wash:0,state:'available',classification_state:'manual'};
    const tshirt:Cloth={...shirt,id:'22222222-2222-4222-8222-222222222222',subtype:'t_shirt'};
    const bottom:Cloth={...shirt,id:'33333333-3333-4333-8333-333333333333',category:'bottom',subtype:'slacks'};
    const plan=recommend({date:today,clothes:[shirt,tshirt,bottom],preferences:{...defaultPreferences,style_keywords:['カジュアル']}});
    expect(plan.items.find(i=>i.slot==='top')?.clothes_id).toBe(tshirt.id);
  });
  test('R2 upload compensates when the post-write account check cannot establish ownership remains active',async()=>{
    const grantId='44444444-4444-4444-8444-444444444444',imageKey=`private/${userId}/image.webp`;
    const objects=new Set<string>();let wrote=false;
    const admin=fakeDatabase(q=>{
      if(q.table==='profiles')return wrote?{__error:{message:'connection interrupted after concurrent deletion'}}:{user_id:userId,deleting_at:null};
      return [];
    },name=>name==='claim_operation'?{state:'new'}:true);
    const user={...fakeDatabase(()=>({id:grantId,user_id:userId,image_key:imageKey,expires_at:new Date(+now+600000).toISOString(),used_at:null})),auth:{getUser:async()=>({data:{user:{id:userId}},error:null})}};
    const bucket={head:async()=>null,put:async(key:string)=>{objects.add(key);wrote=true;},delete:async(key:string)=>{objects.delete(key);}};
    const bytes=new Uint8Array(26);bytes.set(new TextEncoder().encode('RIFF'),0);new DataView(bytes.buffer).setUint32(4,18,true);bytes.set(new TextEncoder().encode('WEBPVP8L'),8);new DataView(bytes.buffer).setUint32(16,6,true);bytes[20]=0x2f;
    const app=createApp({clients:()=>({user,admin} as any),now:()=>now});
    const response=await app.request(`/api/uploads/${grantId}`,{method:'PUT',headers:{Authorization:'Bearer test-token','Idempotency-Key':'upload-review-key','Content-Type':'image/webp'},body:bytes},{SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'private',CLOTHES_BUCKET:bucket} as any);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(objects.has(imageKey)).toBe(false);
  });
  test('onboarding-only update does not issue an empty PostgREST PATCH requiring one returned row',async()=>{
    const admin=fakeDatabase(q=>{
      if(q.table==='profiles')return {user_id:userId,deleting_at:null};
      if(q.table==='user_preferences'){
        // Upstream PostgREST UpdateSpec: PATCH {} with representation returns [].
        // Supabase .single() requires one object and rejects that zero-row result.
        if(q.action==='update'&&Object.keys(q.payload??{}).length===0)return {__error:{code:'PGRST116',message:'Cannot coerce the result to a single JSON object'}};
        return {...defaultPreferences,user_id:userId};
      }
      return [];
    },name=>name==='claim_operation'?{state:'new'}:true);
    const user={...admin,auth:{getUser:async()=>({data:{user:{id:userId}},error:null})}};
    const app=createApp({clients:()=>({user,admin} as any),now:()=>now});
    const response=await app.request('/api/me/preferences',{method:'PATCH',headers:{Authorization:'Bearer test-token','Idempotency-Key':'onboarding-review-key','Content-Type':'application/json'},body:JSON.stringify({onboarding_completed:true})},{SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'private'} as any);
    expect(response.status).toBe(200);
    expect((await response.json()).onboarding_completed).toBe(true);
    expect(admin.queries.some(q=>q.table==='user_preferences'&&q.action==='update'&&Object.keys(q.payload??{}).length===0)).toBe(false);
  });
  test('three-day weather plan caches provider fetch even when the displayed week includes unavailable days',async()=>{
    const cache:any[]=[];
    const db=fakeDatabase(q=>{
      if(q.action==='upsert'){
        const i=cache.findIndex(c=>c.forecast_date===q.payload.forecast_date);
        if(i<0)cache.push(q.payload);else cache[i]=q.payload;
        return null;
      }
      return cache;
    });
    const fetcher=vi.fn(async()=>Response.json({forecast:{forecastday:Array.from({length:3},(_,i)=>({date:addDays(today,i),day:{mintemp_c:12,maxtemp_c:22,daily_chance_of_rain:20}}))}}));
    const dates=Array.from({length:7},(_,i)=>addDays(today,i));
    const env={WEATHER_API_KEY:'test-weather-key',WEATHER_FORECAST_DAYS:'3'} as any;
    await getForecasts(env,db as any,'tokyo',dates,now,fetcher);
    await getForecasts(env,db as any,'tokyo',dates,new Date(+now+1000),fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('manual outfit stays fixed while returned temperature reflects the newest forecast',async()=>{
    const upper:Cloth={id:'11111111-1111-4111-8111-111111111111',category:'top',subtype:'shirt',color:'white',seasons:['autumn'],thickness:'normal',wear_limit:10,wears_since_wash:0,state:'available',classification_state:'manual'};
    const bottom:Cloth={...upper,id:'22222222-2222-4222-8222-222222222222',category:'bottom',subtype:'slacks'};
    const oldWeather={...seasonalWeather(today),source:'live',max_c:25,min_c:18};
    const fixed={id:'plan',target_date:today,outfit_id:'fixed-outfit',mode:'manual_lock',plan_status:'proposed',warnings:[],outfits:{source:'manual',reason_short:'自分で選んだ服',context_snapshot:{warnings:[],weather:oldWeather},outfit_items:[upper,bottom].map(c=>({clothes_id:c.id,slot:c.category,clothes:c}))}};
    const rows:any[]=[fixed];
    const db=fakeDatabase(q=>{
      if(q.table==='user_preferences')return defaultPreferences;
      if(q.table==='clothes')return [upper,bottom];
      if(q.table==='work_weekdays')return [{weekday:1,is_workday:true}];
      if(q.table==='daily_plans')return rows;
      if(q.table==='weather_cache')return Array.from({length:7},(_,i)=>({forecast_date:addDays(today,i),fetched_at:now.toISOString(),payload:{...seasonalWeather(addDays(today,i)),max_c:5,min_c:0}}));
      return [];
    },()=>true);
    const plans=await generatePlans({},db as any,userId,today,now,{force:true,affectedOnly:true});
    const result=plans.find(p=>p.target_date===today)!;
    expect(result.outfit_id).toBe('fixed-outfit');
    expect(result.warnings.join(' ')).toContain('気温が低い');
    expect(result.weather?.max_c).toBe(5);
  });
  test('manual next-day outfit exposes projected laundry warning without changing its clothes',async()=>{
    const upper:Cloth={id:'11111111-1111-4111-8111-111111111111',category:'top',subtype:'shirt',color:'white',seasons:['autumn'],thickness:'normal',wear_limit:1,wears_since_wash:0,state:'available',classification_state:'manual'};
    const bottom:Cloth={...upper,id:'22222222-2222-4222-8222-222222222222',category:'bottom',subtype:'slacks',wear_limit:10};
    const lockedDate=addDays(today,1);
    const rows:any[]=[{id:'fixed-plan',target_date:lockedDate,outfit_id:'fixed-outfit',mode:'manual_lock',plan_status:'proposed',warnings:[],outfits:{source:'manual',reason_short:'自分で選んだ服',context_snapshot:{warnings:[],weather:seasonalWeather(lockedDate)},outfit_items:[upper,bottom].map(c=>({clothes_id:c.id,slot:c.category,clothes:c}))}}];
    const db=fakeDatabase(q=>{
      if(q.table==='user_preferences')return defaultPreferences;
      if(q.table==='clothes')return [upper,bottom];
      if(q.table==='work_weekdays')return [{weekday:1,is_workday:true},{weekday:2,is_workday:true}];
      if(q.table==='daily_plans')return rows;
      if(q.table==='weather_cache')return [];
      return [];
    },(name,args)=>{
      if(name==='save_plan')rows.push({id:crypto.randomUUID(),target_date:args.p_target_date,mode:'auto',plan_status:args.p_data.plan_status,warnings:args.p_data.warnings,outfits:{source:'rule',reason_short:args.p_data.reason_short,context_snapshot:args.p_data.context_snapshot,outfit_items:args.p_data.items}});
      return true;
    });
    const plans=await generatePlans({},db as any,userId,today,now);
    const locked=plans.find(p=>p.target_date===lockedDate)!;
    expect(locked.outfit_id).toBe('fixed-outfit');
    expect(locked.warnings.join(' ')).toContain('洗濯');
  });
});
