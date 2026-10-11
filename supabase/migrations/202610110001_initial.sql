-- Outfit v0.1. All timestamps are UTC; quota boundaries use Asia/Tokyo.
begin;
create extension if not exists pgcrypto;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  onboarding_completed_at timestamptz, deleting_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.user_preferences (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  style_keywords text[] not null default array['シンプル'], dress_code text not null default 'office_casual' check(dress_code in ('free','office_casual')),
  ng_categories text[] not null default '{}', base_region_code text not null default 'tokyo',
  auto_adjust_time time not null default '07:00', holidays_off boolean not null default true,
  weekly_plan_enabled boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.work_weekdays (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  weekday smallint not null check(weekday between 1 and 7), is_workday boolean not null,
  primary key(user_id,weekday)
);
create table public.day_overrides (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  target_date date not null, is_workday boolean not null,
  occasion text not null default 'normal' check(occasion in ('normal','meeting','external_visit','other')),
  mood text check(length(mood)<=80), primary key(user_id,target_date)
);
create table public.upload_grants (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id) on delete cascade,
  request_key text not null, image_key text not null unique, expires_at timestamptz not null,
  used_at timestamptz, created_at timestamptz not null default now(), unique(user_id,request_key),
  check(image_key like 'private/' || user_id::text || '/%.webp')
);
create table public.clothes (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id) on delete cascade,
  request_key text not null, image_key text not null unique,
  category text not null check(category in ('top','bottom','shoes','outerwear')),
  subtype text not null default '' check(length(subtype)<=50), color text not null default 'unknown' check(length(color) between 1 and 30), seasons text[] not null default '{}',
  thickness text check(thickness in ('thin','normal','thick')), wear_limit integer not null default 1 check(wear_limit>0 and wear_limit<=100),
  wears_since_wash integer not null default 0 check(wears_since_wash>=0),
  state text not null default 'available' check(state in ('available','laundry')),
  is_available boolean not null default true,
  classification_state text not null default 'manual' check(classification_state in ('pending','classified','manual','review')),
  last_washed_at timestamptz, deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,id), unique(user_id,request_key), check(image_key like 'private/' || user_id::text || '/%.webp'),
  check(seasons <@ array['spring','summer','autumn','winter'])
);
create index clothes_active on public.clothes(user_id,state,category) where deleted_at is null;
create table public.outfits (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id) on delete cascade,
  source text not null check(source in ('ai','rule','manual')), reason_short text not null check(length(reason_short)<=100 and position(E'\n' in reason_short)=0 and position(E'\r' in reason_short)=0),
  context_snapshot jsonb not null default '{}', validation_state text not null default 'valid',
  created_at timestamptz not null default now(), unique(user_id,id)
);
create table public.outfit_items (
  user_id uuid not null, outfit_id uuid not null, clothes_id uuid not null,
  slot text not null check(slot in ('top','bottom','shoes','outerwear')),
  primary key(outfit_id,clothes_id), unique(outfit_id,slot),
  foreign key(user_id,outfit_id) references public.outfits(user_id,id) on delete cascade,
  foreign key(user_id,clothes_id) references public.clothes(user_id,id) on delete cascade
);
create table public.weather_cache (
  id uuid primary key default gen_random_uuid(), region_code text not null, forecast_date date not null,
  payload jsonb not null, fetched_at timestamptz not null default now(), unique(region_code,forecast_date)
);
create table public.daily_plans (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id) on delete cascade,
  target_date date not null, outfit_id uuid,
  mode text not null default 'auto' check(mode in ('auto','manual_lock')),
  plan_status text not null default 'proposed' check(plan_status in ('proposed','partial','confirmed','skipped')),
  weather_observation_id uuid references public.weather_cache(id) on delete set null,
  last_adjusted_at timestamptz not null default now(), warnings jsonb not null default '[]',
  unique(user_id,target_date), foreign key(user_id,outfit_id) references public.outfits(user_id,id)
);
create table public.wear_logs (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id) on delete cascade,
  target_date date not null, outfit_id uuid not null, confirmed_at timestamptz not null default now(),
  unique(user_id,target_date), unique(user_id,id), foreign key(user_id,outfit_id) references public.outfits(user_id,id)
);
create table public.wear_log_items (
  user_id uuid not null, wear_log_id uuid not null, clothes_id uuid not null,
  primary key(wear_log_id,clothes_id),
  foreign key(user_id,wear_log_id) references public.wear_logs(user_id,id) on delete cascade,
  foreign key(user_id,clothes_id) references public.clothes(user_id,id) on delete cascade
);
create table public.laundry_events (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id) on delete cascade,
  clothes_id uuid not null, event_type text not null check(event_type in ('worn','washed','marked_laundry','corrected')),
  event_at timestamptz not null default now(), source_id uuid, delta integer not null default 0,
  foreign key(user_id,clothes_id) references public.clothes(user_id,id) on delete cascade
);
create index wear_logs_date on public.wear_logs(user_id,target_date desc);
create table public.outfit_feedback (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id) on delete cascade,
  target_date date not null, outfit_id uuid, reason text check(reason in ('dislike_item','more_casual','different','other')),
  created_at timestamptz not null default now(), foreign key(user_id,outfit_id) references public.outfits(user_id,id)
);
create table public.operation_receipts (
  user_id uuid not null references public.profiles(user_id) on delete cascade, operation text not null,
  request_key text not null, result jsonb not null, created_at timestamptz not null default now(), primary key(user_id,operation,request_key)
);
create table public.quota_counters (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  action text not null check(action in ('daily_regen','weekly_regen')), period_start date not null,
  used integer not null default 0 check(used>=0), primary key(user_id,action,period_start)
);
create table public.rate_limits (
  user_id uuid not null references public.profiles(user_id) on delete cascade, bucket text not null,
  window_start timestamptz not null, used integer not null check(used>=0), primary key(user_id,bucket)
);
create table public.service_budget (
  billing_month date primary key check(extract(day from billing_month)=1),
  max_ai_usd numeric not null check(max_ai_usd>=0), reserved_ai_usd numeric not null default 0 check(reserved_ai_usd>=0),
  spent_ai_usd numeric not null default 0 check(spent_ai_usd>=0), ai_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id) on delete cascade,
  action text not null check(action in ('classify','daily_regen','weekly_regen','scheduled','other')),
  request_key text not null, billing_month date not null references public.service_budget(billing_month),
  estimated_cost_usd numeric not null check(estimated_cost_usd>=0), actual_cost_usd numeric,
  provider_request_id text, input_tokens integer, output_tokens integer,
  status text not null default 'reserved' check(status in ('reserved','succeeded','failed')),
  created_at timestamptz not null default now(), unique(user_id,request_key)
);
-- User UUID remains only until deletion's final stage; a minimal completion receipt
-- survives Auth deletion, with no user UUID, images or account data in its payload.
create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(), user_id uuid,
  job_type text not null, target_date date, payload jsonb not null default '{}',
  status text not null default 'pending' check(status in ('pending','running','completed','failed')),
  attempt_count integer not null default 0, lease_until timestamptz, lease_token uuid,
  dedupe_key text not null unique, last_error_code text, next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index jobs_due on public.generation_jobs(status,next_attempt_at,lease_until);
-- A durable, service-only cursor keeps orphan reconciliation advancing beyond
-- the first bucket page, including late PUTs after deletion removed grants.
create table public.maintenance_state (
  key text primary key, cursor text, updated_at timestamptz not null default now()
);

create function public.is_active_user(p_user_id uuid) returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where user_id=p_user_id and deleting_at is null) $$;
create function public.lock_active_user(p_user_id uuid) returns void language plpgsql security definer set search_path=public
as $$ begin
  perform 1 from public.profiles where user_id=p_user_id and deleting_at is null for update;
  if not found then raise exception 'ACCOUNT_UNAVAILABLE' using errcode='42501'; end if;
end $$;
create function public.guard_job_owner() returns trigger language plpgsql set search_path=public,pg_temp
as $$ begin
  if tg_op='UPDATE' and (new.id<>old.id or new.job_type<>old.job_type or new.user_id is distinct from old.user_id) then
    -- The sole owner change is final account-deletion anonymization.
    if new.id=old.id and old.job_type='account_delete' and new.job_type='account_delete'
      and new.user_id is null and new.status='completed' and new.payload='{}'::jsonb and new.dedupe_key='deleted:'||new.id then return new; end if;
    raise exception 'IMMUTABLE_JOB_OWNER';
  end if;
  if new.job_type='account_delete' then
    if tg_op='INSERT' then
      perform 1 from profiles where user_id=new.user_id for update;
      if not found then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
    end if;
  elsif tg_op='INSERT' or new.payload is distinct from old.payload or new.dedupe_key is distinct from old.dedupe_key then
    -- A queued request may reach INSERT after its API auth check and after a
    -- concurrent deletion. Serialize the actual enqueue with the tombstone.
    perform lock_active_user(new.user_id);
  end if;
  -- Lifecycle-only cancellation/lease completion remains possible during
  -- deletion; it cannot create or reassign a user's data after row erasure.
  return new;
end $$;
create trigger generation_job_owner_guard before insert or update on public.generation_jobs for each row execute function public.guard_job_owner();
create function public.ensure_profile(p_user_id uuid) returns jsonb language plpgsql security definer set search_path=public
as $$ begin
  insert into profiles(user_id) values(p_user_id) on conflict do nothing;
  perform lock_active_user(p_user_id);
  insert into user_preferences(user_id) values(p_user_id) on conflict do nothing;
  insert into work_weekdays(user_id,weekday,is_workday) select p_user_id,d,d<=5 from generate_series(1,7) d on conflict do nothing;
  return (select to_jsonb(p) from profiles p where user_id=p_user_id);
end $$;

create function public.reserve_upload(p_user_id uuid,p_request_key text) returns jsonb language plpgsql security definer set search_path=public
as $$ declare v upload_grants; n integer; begin
  perform lock_active_user(p_user_id);
  select * into v from upload_grants where user_id=p_user_id and request_key=p_request_key;
  if found then return to_jsonb(v); end if;
  select (select count(*) from clothes where user_id=p_user_id and deleted_at is null)
    +(select count(*) from upload_grants where user_id=p_user_id and used_at is null and expires_at>now()) into n;
  if n>=100 then raise exception 'CLOTHES_LIMIT' using errcode='P0001'; end if;
  insert into upload_grants(user_id,request_key,image_key,expires_at)
    values(p_user_id,p_request_key,'private/'||p_user_id||'/'||gen_random_uuid()||'.webp',now()+interval '10 minutes') returning * into v;
  return to_jsonb(v);
end $$;
create function public.guard_clothes() returns trigger language plpgsql set search_path=public
as $$ begin
  perform lock_active_user(new.user_id);
  if tg_op='UPDATE' and (new.user_id<>old.user_id or new.id<>old.id or new.image_key<>old.image_key) then
    raise exception 'IMMUTABLE_OWNER';
  end if;
  if (tg_op='INSERT' or (old.deleted_at is not null and new.deleted_at is null)) and new.deleted_at is null
    and (select count(*) from clothes where user_id=new.user_id and deleted_at is null)>=100 then raise exception 'CLOTHES_LIMIT'; end if;
  if new.wears_since_wash>=new.wear_limit then new.state:='laundry'; end if;
  new.updated_at:=now(); return new;
end $$;
create trigger clothes_guard before insert or update on public.clothes for each row execute function public.guard_clothes();
create function public.audit_marked_laundry() returns trigger language plpgsql set search_path=public,pg_temp
as $$ begin
  if new.state='laundry' and old.state<>'laundry' and new.wears_since_wash=old.wears_since_wash and new.wears_since_wash<new.wear_limit then
    insert into laundry_events(user_id,clothes_id,event_type) values(new.user_id,new.id,'marked_laundry');
  end if;
  return new;
end $$;
create trigger clothes_laundry_audit after update on public.clothes for each row execute function public.audit_marked_laundry();
create function public.create_clothes(p_user_id uuid,p_request_key text,p_data jsonb) returns jsonb language plpgsql security definer set search_path=public
as $$ declare v clothes; g upload_grants; begin
  perform lock_active_user(p_user_id);
  select * into v from clothes where user_id=p_user_id and request_key=p_request_key;
  if found then return to_jsonb(v); end if;
  select * into g from upload_grants where user_id=p_user_id and image_key=p_data->>'image_key' for update;
  if not found or g.used_at is not null or g.expires_at<=now() then raise exception 'UPLOAD_INVALID'; end if;
  insert into clothes(user_id,request_key,image_key,category,subtype,color,seasons,thickness,wear_limit,classification_state)
    values(p_user_id,p_request_key,p_data->>'image_key',coalesce(p_data->>'category','top'),coalesce(p_data->>'subtype',''),
      coalesce(p_data->>'color','unknown'),array(select jsonb_array_elements_text(coalesce(p_data->'seasons','[]'))),
      p_data->>'thickness',coalesce((p_data->>'wear_limit')::integer,1),coalesce(p_data->>'classification_state','pending')) returning * into v;
  update upload_grants set used_at=now() where id=g.id;
  return to_jsonb(v);
end $$;

create function public.plan_json(p_user_id uuid,p_target_date date) returns jsonb language sql stable set search_path=public
as $$ select to_jsonb(p)||jsonb_build_object('outfit',to_jsonb(o),'items',coalesce((select jsonb_agg(to_jsonb(i)) from outfit_items i where i.outfit_id=p.outfit_id),'[]'))
  from daily_plans p left join outfits o on o.id=p.outfit_id where p.user_id=p_user_id and p.target_date=p_target_date $$;
create function public.assert_job_lease(p_user_id uuid,p_job_id uuid,p_lease_token uuid) returns void language plpgsql set search_path=public,pg_temp
as $$ begin
  if p_job_id is null and p_lease_token is null then return; end if;
  perform 1 from generation_jobs where id=p_job_id and user_id=p_user_id and lease_token=p_lease_token and status='running' and lease_until>clock_timestamp() for share;
  if not found then raise exception 'LEASE_LOST'; end if;
end $$;
create function public.save_plan(p_user_id uuid,p_target_date date,p_data jsonb,p_manual boolean default false,p_job_id uuid default null,p_lease_token uuid default null) returns jsonb language plpgsql security definer set search_path=public
as $$ declare v daily_plans; oid uuid; item jsonb; c clothes; pref user_preferences; begin
  perform lock_active_user(p_user_id);
  perform assert_job_lease(p_user_id,p_job_id,p_lease_token);
  select * into v from daily_plans where user_id=p_user_id and target_date=p_target_date for update;
  if found and (v.plan_status='confirmed' or (v.mode='manual_lock' and not p_manual)) then
    if not p_manual then update daily_plans set warnings=coalesce(p_data->'warnings','[]') where id=v.id; end if;
    return plan_json(p_user_id,p_target_date);
  end if;
  select * into pref from user_preferences where user_id=p_user_id;
  insert into outfits(user_id,source,reason_short,context_snapshot,validation_state)
    values(p_user_id,case when p_manual then 'manual' else coalesce(p_data->>'source','rule') end,
      coalesce(p_data->>'reason_short','登録した服から選びました'),coalesce(p_data->'context_snapshot','{}'),coalesce(p_data->>'validation_state','valid')) returning id into oid;
  for item in select * from jsonb_array_elements(coalesce(p_data->'items','[]')) loop
    select * into c from clothes where id=(item->>'clothes_id')::uuid and user_id=p_user_id;
    if not found or c.deleted_at is not null or c.category<>item->>'slot' then raise exception 'INVALID_CLOTHES'; end if;
    if c.state='laundry' or not c.is_available or c.wears_since_wash>=c.wear_limit or c.classification_state='pending'
      or exists(select 1 from unnest(pref.ng_categories) ng where lower(ng) in (lower(c.category),lower(c.subtype)))
      or (pref.dress_code='office_casual' and lower(c.subtype) in ('shorts','flip_flops','beach_sandals','tank_top','短パン','ビーチサンダル','タンクトップ')) then raise exception 'UNAVAILABLE_CLOTHES'; end if;
    insert into outfit_items(user_id,outfit_id,clothes_id,slot) values(p_user_id,oid,c.id,item->>'slot');
  end loop;
  insert into daily_plans(user_id,target_date,outfit_id,mode,plan_status,warnings)
    values(p_user_id,p_target_date,oid,case when p_manual then 'manual_lock' else 'auto' end,coalesce(p_data->>'plan_status','proposed'),coalesce(p_data->'warnings','[]'))
    on conflict(user_id,target_date) do update set outfit_id=excluded.outfit_id,mode=excluded.mode,plan_status=excluded.plan_status,warnings=excluded.warnings,last_adjusted_at=now();
  return plan_json(p_user_id,p_target_date);
end $$;

create function public.complete_classification(p_user_id uuid,p_clothes_id uuid,p_data jsonb,p_job_id uuid,p_lease_token uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$ declare v clothes; begin
  perform lock_active_user(p_user_id);
  perform assert_job_lease(p_user_id,p_job_id,p_lease_token);
  update clothes set category=coalesce(p_data->>'category',category),subtype=coalesce(p_data->>'subtype',subtype),color=coalesce(p_data->>'color',color),
    seasons=case when p_data?'seasons' then array(select jsonb_array_elements_text(p_data->'seasons')) else seasons end,
    wear_limit=coalesce((p_data->>'wear_limit')::integer,wear_limit),classification_state=coalesce(p_data->>'classification_state','manual')
    where user_id=p_user_id and id=p_clothes_id and deleted_at is null and classification_state='pending' returning * into v;
  if not found then select * into v from clothes where user_id=p_user_id and id=p_clothes_id; end if;
  return to_jsonb(v);
end $$;

create function public.claim_operation(p_user_id uuid,p_operation text,p_request_key text,p_hash text) returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$ declare r jsonb; begin
  perform lock_active_user(p_user_id);
  select result into r from operation_receipts where user_id=p_user_id and operation='http:'||p_operation and request_key=p_request_key;
  if found then
    if r->>'hash'<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    if r->>'state'='complete' then return r; end if;
    if (r->>'expires_at')::timestamptz>clock_timestamp() then return jsonb_build_object('state','pending'); end if;
  end if;
  r:=jsonb_build_object('state','pending','hash',p_hash,'expires_at',clock_timestamp()+interval '5 minutes');
  insert into operation_receipts(user_id,operation,request_key,result) values(p_user_id,'http:'||p_operation,p_request_key,r)
    on conflict(user_id,operation,request_key) do update set result=excluded.result,created_at=now();
  return jsonb_build_object('state','new');
end $$;
create function public.finish_operation(p_user_id uuid,p_operation text,p_request_key text,p_hash text,p_status integer,p_response jsonb) returns void language plpgsql security definer set search_path=public,pg_temp
as $$ begin
  -- Finishing a delete request must still work after its tombstone is set.
  perform 1 from profiles where user_id=p_user_id for update;
  update operation_receipts set result=jsonb_build_object('state','complete','hash',p_hash,'status',p_status,'response',p_response)
    where user_id=p_user_id and operation='http:'||p_operation and request_key=p_request_key and result->>'hash'=p_hash;
end $$;
create function public.abort_operation(p_user_id uuid,p_operation text,p_request_key text,p_hash text) returns void language plpgsql security definer set search_path=public,pg_temp
as $$ begin
  perform 1 from profiles where user_id=p_user_id for update;
  delete from operation_receipts where user_id=p_user_id and operation='http:'||p_operation and request_key=p_request_key and result->>'hash'=p_hash and result->>'state'='pending';
end $$;

create function public.validate_wear(p_user_id uuid,p_outfit_id uuid,p_existing_log uuid default null) returns void language plpgsql set search_path=public
as $$ declare pref user_preferences; begin
  if not exists(select 1 from outfits where id=p_outfit_id and user_id=p_user_id) then raise exception 'INVALID_OUTFIT'; end if;
  if not exists(select 1 from outfit_items where outfit_id=p_outfit_id and slot='top')
    or not exists(select 1 from outfit_items where outfit_id=p_outfit_id and slot='bottom') then raise exception 'MISSING_REQUIRED_ITEMS'; end if;
  select * into pref from user_preferences where user_id=p_user_id;
  if exists(select 1 from outfit_items i join clothes c on c.id=i.clothes_id
    where i.outfit_id=p_outfit_id and (c.user_id<>p_user_id or c.deleted_at is not null or not c.is_available or c.category<>i.slot or c.classification_state='pending'
      or exists(select 1 from unnest(pref.ng_categories) ng where lower(ng) in (lower(c.category),lower(c.subtype)))
      or (pref.dress_code='office_casual' and lower(c.subtype) in ('shorts','flip_flops','beach_sandals','tank_top','短パン','ビーチサンダル','タンクトップ'))
      or ((c.state='laundry' or c.wears_since_wash>=c.wear_limit) and not exists(select 1 from wear_log_items w where w.wear_log_id=p_existing_log and w.clothes_id=c.id)))) then raise exception 'UNAVAILABLE_CLOTHES'; end if;
end $$;
create function public.confirm_wear(p_user_id uuid,p_target_date date,p_outfit_id uuid,p_request_key text) returns jsonb language plpgsql security definer set search_path=public
as $$ declare v wear_logs; c record; begin
  perform lock_active_user(p_user_id);
  select * into v from wear_logs where user_id=p_user_id and target_date=p_target_date;
  if found then return to_jsonb(v); end if;
  if p_target_date>(now() at time zone 'Asia/Tokyo')::date then raise exception 'FUTURE_WEAR'; end if;
  perform validate_wear(p_user_id,p_outfit_id);
  insert into wear_logs(user_id,target_date,outfit_id) values(p_user_id,p_target_date,p_outfit_id) returning * into v;
  for c in select clothes_id from outfit_items where outfit_id=p_outfit_id loop
    insert into wear_log_items(user_id,wear_log_id,clothes_id) values(p_user_id,v.id,c.clothes_id);
    update clothes set wears_since_wash=wears_since_wash+1 where id=c.clothes_id;
    insert into laundry_events(user_id,clothes_id,event_type,source_id,delta) values(p_user_id,c.clothes_id,'worn',v.id,1);
  end loop;
  update daily_plans set outfit_id=p_outfit_id,plan_status='confirmed' where user_id=p_user_id and target_date=p_target_date;
  return to_jsonb(v);
end $$;
create function public.correct_wear(p_user_id uuid,p_target_date date,p_outfit_id uuid,p_request_key text) returns jsonb language plpgsql security definer set search_path=public
as $$ declare v wear_logs; c record; r jsonb; d integer; begin
  perform lock_active_user(p_user_id);
  select result into r from operation_receipts where user_id=p_user_id and operation='correct_wear' and request_key=p_request_key;
  if found then return r; end if;
  select * into v from wear_logs where user_id=p_user_id and target_date=p_target_date for update;
  if not found then raise exception 'WEAR_NOT_FOUND'; end if;
  perform validate_wear(p_user_id,p_outfit_id,v.id);
  for c in select garment.* from clothes garment join wear_log_items w on w.clothes_id=garment.id where w.wear_log_id=v.id
    and not exists(select 1 from outfit_items i where i.outfit_id=p_outfit_id and i.clothes_id=garment.id) loop
    d:=case when c.last_washed_at is null or c.last_washed_at<v.confirmed_at then -1 else 0 end;
    update clothes set wears_since_wash=greatest(0,wears_since_wash+d),state=case when wears_since_wash>=wear_limit and wears_since_wash+d<wear_limit then 'available' else state end where id=c.id;
    insert into laundry_events(user_id,clothes_id,event_type,source_id,delta) values(p_user_id,c.id,'corrected',v.id,d);
    delete from wear_log_items where wear_log_id=v.id and clothes_id=c.id;
  end loop;
  for c in select garment.* from clothes garment join outfit_items i on i.clothes_id=garment.id where i.outfit_id=p_outfit_id
    and not exists(select 1 from wear_log_items w where w.wear_log_id=v.id and w.clothes_id=garment.id) loop
    d:=case when c.last_washed_at is null or c.last_washed_at<v.confirmed_at then 1 else 0 end;
    update clothes set wears_since_wash=wears_since_wash+d where id=c.id;
    insert into wear_log_items(user_id,wear_log_id,clothes_id) values(p_user_id,v.id,c.id);
    insert into laundry_events(user_id,clothes_id,event_type,source_id,delta) values(p_user_id,c.id,'corrected',v.id,d);
  end loop;
  update wear_logs set outfit_id=p_outfit_id where id=v.id returning * into v;
  update daily_plans set outfit_id=p_outfit_id,mode='manual_lock',plan_status='confirmed' where user_id=p_user_id and target_date=p_target_date;
  r:=to_jsonb(v); insert into operation_receipts values(p_user_id,'correct_wear',p_request_key,r,now()); return r;
end $$;
create function public.wash_clothes(p_user_id uuid,p_clothes_id uuid,p_request_key text) returns jsonb language plpgsql security definer set search_path=public
as $$ declare r jsonb; v clothes; begin
  perform lock_active_user(p_user_id);
  select result into r from operation_receipts where user_id=p_user_id and operation='wash_clothes' and request_key=p_request_key;
  if found then return r; end if;
  update clothes set wears_since_wash=0,state='available',last_washed_at=clock_timestamp()
    where id=p_clothes_id and user_id=p_user_id and deleted_at is null returning * into v;
  if not found then raise exception 'CLOTHES_NOT_FOUND'; end if;
  insert into laundry_events(user_id,clothes_id,event_type) values(p_user_id,p_clothes_id,'washed');
  r:=to_jsonb(v); insert into operation_receipts values(p_user_id,'wash_clothes',p_request_key,r,now()); return r;
end $$;

create function public.consume_quota(p_user_id uuid,p_action text,p_request_key text) returns jsonb language plpgsql security definer set search_path=public
as $$ declare period date; lim integer; n integer; r jsonb; begin
  perform lock_active_user(p_user_id);
  select result into r from operation_receipts where user_id=p_user_id and operation=p_action and request_key=p_request_key;
  if found then return r||'{"replayed":true}'::jsonb; end if;
  if p_action='daily_regen' then period:=(now() at time zone 'Asia/Tokyo')::date; lim:=3;
  elsif p_action='weekly_regen' then period:=date_trunc('week',now() at time zone 'Asia/Tokyo')::date; lim:=2;
  else raise exception 'INVALID_QUOTA_ACTION'; end if;
  insert into quota_counters(user_id,action,period_start) values(p_user_id,p_action,period) on conflict do nothing;
  select used into n from quota_counters where user_id=p_user_id and action=p_action and period_start=period for update;
  if n>=lim then return jsonb_build_object('allowed',false,'remaining',0,'period_start',period); end if;
  update quota_counters set used=used+1 where user_id=p_user_id and action=p_action and period_start=period;
  r:=jsonb_build_object('allowed',true,'remaining',lim-n-1,'period_start',period);
  insert into operation_receipts values(p_user_id,p_action,p_request_key,r,now()); return r;
end $$;
create function public.check_rate_limit(p_user_id uuid,p_bucket text,p_limit integer,p_window_seconds integer) returns boolean language plpgsql security definer set search_path=public
as $$ declare v rate_limits; begin
  perform lock_active_user(p_user_id);
  if p_limit<1 or p_window_seconds<1 then return false; end if;
  select * into v from rate_limits where user_id=p_user_id and bucket=p_bucket;
  if not found or v.window_start+make_interval(secs=>p_window_seconds)<=now() then
    insert into rate_limits values(p_user_id,p_bucket,now(),1) on conflict(user_id,bucket) do update set window_start=now(),used=1; return true;
  end if;
  if v.used>=p_limit then return false; end if;
  update rate_limits set used=used+1 where user_id=p_user_id and bucket=p_bucket; return true;
end $$;
create function public.reserve_ai(p_user_id uuid,p_action text,p_estimate numeric,p_request_key text) returns uuid language plpgsql security definer set search_path=public
as $$ declare m date:=date_trunc('month',now() at time zone 'Asia/Tokyo')::date; b service_budget; v ai_usage; begin
  perform lock_active_user(p_user_id);
  select * into v from ai_usage where user_id=p_user_id and request_key=p_request_key;
  -- A repeated receipt must never authorize a second provider request.
  if found then return null; end if;
  if p_estimate<=0 then raise exception 'INVALID_ESTIMATE'; end if;
  select * into b from service_budget where billing_month=m for update;
  if not found or not b.ai_enabled or b.spent_ai_usd+b.reserved_ai_usd+p_estimate>b.max_ai_usd then return null; end if;
  if (select count(*) from ai_usage where status='reserved')>=4 then return null; end if;
  update service_budget set reserved_ai_usd=reserved_ai_usd+p_estimate,updated_at=now() where billing_month=m;
  insert into ai_usage(user_id,action,request_key,billing_month,estimated_cost_usd) values(p_user_id,p_action,p_request_key,m,p_estimate) returning * into v; return v.id;
end $$;
create function public.settle_ai(p_usage_id uuid,p_actual numeric,p_success boolean) returns void language plpgsql security definer set search_path=public
as $$ declare v ai_usage; begin
  select * into v from ai_usage where id=p_usage_id for update;
  if not found or v.status<>'reserved' then return; end if;
  if p_actual<0 then raise exception 'INVALID_COST'; end if;
  update service_budget set reserved_ai_usd=greatest(0,reserved_ai_usd-v.estimated_cost_usd),spent_ai_usd=spent_ai_usd+p_actual,
    ai_enabled=ai_enabled and spent_ai_usd+p_actual<max_ai_usd,updated_at=now() where billing_month=v.billing_month;
  update ai_usage set actual_cost_usd=p_actual,status=case when p_success then 'succeeded' else 'failed' end where id=v.id;
end $$;
create function public.lease_jobs(p_limit integer default 10) returns setof public.generation_jobs language plpgsql security definer set search_path=public
as $$ begin
  update generation_jobs set status='failed',last_error_code='LEASE_EXHAUSTED',lease_until=null,lease_token=null
    where status='running' and lease_until<now() and attempt_count>=8;
  return query
  with due as (select id from generation_jobs where ((status='pending' and next_attempt_at<=now()) or (status='running' and lease_until<now()))
    and attempt_count<8 order by
      case job_type when 'account_delete' then 0 when 'daily' then 1 when 'weekly' then 2 when 'classify' then 3 when 'image_delete' then 4 when 'reevaluate' then 5 else 6 end,
      target_date nulls last,next_attempt_at,created_at
    for update skip locked limit greatest(0,least(p_limit,25)))
  update generation_jobs j set status='running',attempt_count=j.attempt_count+1,lease_until=now()+interval '5 minutes',lease_token=gen_random_uuid()
    from due where j.id=due.id returning j.*;
end $$;
create function public.finish_job(p_id uuid,p_lease_token uuid,p_success boolean,p_error_code text default null) returns boolean language plpgsql security definer set search_path=public
as $$ begin
  update generation_jobs set status=case when p_success then 'completed' when attempt_count>=8 then 'failed' else 'pending' end,
    lease_until=null,lease_token=null,last_error_code=left(p_error_code,80),next_attempt_at=now()+make_interval(secs=>least(3600,power(2,attempt_count)::integer*10))
    where id=p_id and lease_token=p_lease_token and status='running' and lease_until>now(); return found;
end $$;
create function public.lease_job(p_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$ declare v generation_jobs; begin
  update generation_jobs set status='failed',last_error_code='LEASE_EXHAUSTED',lease_until=null,lease_token=null
    where id=p_id and status='running' and lease_until<clock_timestamp() and attempt_count>=8;
  select * into v from generation_jobs where id=p_id
    and ((status='pending' and next_attempt_at<=clock_timestamp()) or (status='running' and lease_until<clock_timestamp()))
    and attempt_count<8 for update skip locked;
  if not found then return null; end if;
  update generation_jobs set status='running',attempt_count=attempt_count+1,lease_until=clock_timestamp()+interval '5 minutes',lease_token=gen_random_uuid()
    where id=p_id returning * into v;
  return to_jsonb(v);
end $$;
create function public.finish_deletion(p_id uuid,p_lease_token uuid) returns boolean language plpgsql security definer set search_path=public,pg_temp
as $$ begin
  update generation_jobs set status='completed',user_id=null,payload='{}',dedupe_key='deleted:'||id,
    lease_until=null,lease_token=null,last_error_code=null
    where id=p_id and job_type='account_delete' and status='running' and lease_token=p_lease_token and lease_until>clock_timestamp();
  return found;
end $$;
create function public.begin_deletion(p_user_id uuid) returns jsonb language plpgsql security definer set search_path=public
as $$ declare v generation_jobs; begin
  perform 1 from profiles where user_id=p_user_id for update;
  if not found then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
  update profiles set deleting_at=coalesce(deleting_at,now()) where user_id=p_user_id;
  update generation_jobs set status='failed',last_error_code='ACCOUNT_DELETING',lease_token=null,lease_until=null where user_id=p_user_id and job_type<>'account_delete' and status in ('pending','running');
  insert into generation_jobs(user_id,job_type,dedupe_key,payload) values(p_user_id,'account_delete','account_delete:'||p_user_id,'{"stage":"images"}')
    on conflict(dedupe_key) do update set dedupe_key=excluded.dedupe_key returning * into v;
  return to_jsonb(v);
end $$;

-- No direct client mutation can bypass the transaction and accounting rules.
do $$ declare t text; begin
  foreach t in array array['profiles','user_preferences','work_weekdays','day_overrides','upload_grants','clothes','outfits','outfit_items','daily_plans','wear_logs','wear_log_items','laundry_events','outfit_feedback','operation_receipts','quota_counters','rate_limits','ai_usage','generation_jobs','service_budget','weather_cache','maintenance_state'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  foreach t in array array['profiles','user_preferences','work_weekdays','day_overrides','upload_grants','clothes','outfits','outfit_items','daily_plans','wear_logs','wear_log_items','laundry_events','outfit_feedback','quota_counters'] loop
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy own_active_read on public.%I for select to authenticated using (auth.uid()=user_id and public.is_active_user(user_id))',t);
  end loop;
end $$;
grant select on public.weather_cache to authenticated;
create policy authenticated_weather on public.weather_cache for select to authenticated using(public.is_active_user(auth.uid()));
-- Explicitly put pg_temp last: merely setting search_path=public still lets
-- temporary relations shadow unqualified table names in PostgreSQL functions.
do $$ declare fn regprocedure; begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array['is_active_user','lock_active_user','guard_job_owner','ensure_profile','reserve_upload','guard_clothes','audit_marked_laundry','create_clothes','plan_json','assert_job_lease','save_plan','complete_classification','claim_operation','finish_operation','abort_operation','validate_wear','confirm_wear','correct_wear','wash_clothes','consume_quota','check_rate_limit','reserve_ai','settle_ai','lease_jobs','lease_job','finish_job','finish_deletion','begin_deletion'])
  loop
    execute format('alter function %s set search_path = public, pg_temp',fn);
    execute format('revoke execute on function %s from public, anon, authenticated',fn);
    execute format('grant execute on function %s to service_role',fn);
  end loop;
end $$;
grant execute on function public.is_active_user(uuid) to authenticated;
commit;
