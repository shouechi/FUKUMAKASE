-- Deletion generations make a short Undo safe against image jobs and retries.
begin;
alter table public.clothes
  add column deletion_token uuid,
  add column undo_until timestamptz,
  add column image_purge_started_at timestamptz;
alter table public.clothes add constraint clothes_deletion_generation check (
  (image_purge_started_at is null or deleted_at is not null)
  and ((deletion_token is null and undo_until is null)
    or (deleted_at is not null and deletion_token is not null and undo_until is not null
      and undo_until>deleted_at))
);

create function public.delete_clothes(p_user_id uuid,p_clothes_id uuid,p_request_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$ declare v clothes; r jsonb; t timestamptz; begin
  perform lock_active_user(p_user_id);
  select result into r from operation_receipts where user_id=p_user_id and operation='clothes_delete:'||p_clothes_id and request_key=p_request_key;
  if found then return r; end if;
  select * into v from clothes where user_id=p_user_id and id=p_clothes_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.deleted_at is not null then raise exception 'DELETION_CONFLICT'; end if;
  t:=clock_timestamp();
  update clothes set deleted_at=t,deletion_token=gen_random_uuid(),undo_until=t+interval '30 seconds',image_purge_started_at=null
    where id=v.id returning * into v;
  -- A classification running before deletion must not write into a restored generation.
  update generation_jobs set status='failed',last_error_code='CLOTHES_DELETED',lease_token=null,lease_until=null
    where user_id=p_user_id and job_type='classify' and payload->>'clothes_id'=v.id::text and status in ('pending','running');
  insert into generation_jobs(user_id,job_type,payload,dedupe_key,next_attempt_at)
    values(p_user_id,'image_delete',jsonb_build_object('clothes_id',v.id,'image_key',v.image_key,'deletion_token',v.deletion_token),
      'image_delete:'||v.id||':'||v.deletion_token,v.undo_until);
  insert into generation_jobs(user_id,job_type,target_date,dedupe_key)
    values(p_user_id,'reevaluate',(t at time zone 'Asia/Tokyo')::date,'reevaluate:delete:'||v.deletion_token);
  r:=jsonb_build_object('ok',true,'clothes_id',v.id,'category',v.category,'color',v.color,'deletion_token',v.deletion_token,'undo_until',v.undo_until,'server_now',t);
  insert into operation_receipts(user_id,operation,request_key,result) values(p_user_id,'clothes_delete:'||v.id,p_request_key,r);
  return r;
end $$;

create function public.restore_clothes(p_user_id uuid,p_clothes_id uuid,p_request_key text,p_deletion_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$ declare v clothes; r jsonb; n integer; t timestamptz; begin
  perform lock_active_user(p_user_id);
  select result into r from operation_receipts where user_id=p_user_id and operation='clothes_restore:'||p_clothes_id and request_key=p_request_key;
  if found then
    if r->>'deletion_token' is distinct from p_deletion_token::text then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return r->'cloth';
  end if;
  select * into v from clothes where user_id=p_user_id and id=p_clothes_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.deleted_at is null or v.deletion_token is distinct from p_deletion_token then raise exception 'DELETION_CONFLICT'; end if;
  t:=clock_timestamp();
  if v.undo_until is null or v.undo_until<=t or v.image_purge_started_at is not null then raise exception 'UNDO_EXPIRED'; end if;
  select (select count(*) from clothes where user_id=p_user_id and deleted_at is null)
    +(select count(*) from upload_grants where user_id=p_user_id and used_at is null and expires_at>t) into n;
  if n>=100 then raise exception 'CLOTHES_LIMIT'; end if;
  update clothes set deleted_at=null,deletion_token=null,undo_until=null,image_purge_started_at=null where id=v.id returning * into v;
  update generation_jobs set status='completed',lease_token=null,lease_until=null
    where user_id=p_user_id and job_type='image_delete' and payload->>'deletion_token'=p_deletion_token::text and status in ('pending','running');
  if v.classification_state='pending' then
    insert into generation_jobs(user_id,job_type,payload,dedupe_key)
      values(p_user_id,'classify',jsonb_build_object('clothes_id',v.id),'classify:restore:'||p_deletion_token);
  end if;
  insert into generation_jobs(user_id,job_type,target_date,dedupe_key)
    values(p_user_id,'reevaluate',(t at time zone 'Asia/Tokyo')::date,'reevaluate:restore:'||p_deletion_token);
  r:=jsonb_build_object('deletion_token',p_deletion_token,'cloth',to_jsonb(v));
  insert into operation_receipts(user_id,operation,request_key,result) values(p_user_id,'clothes_restore:'||v.id,p_request_key,r);
  return to_jsonb(v);
end $$;

create function public.list_clothes_deletions(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$ declare t timestamptz; r jsonb; begin
  perform lock_active_user(p_user_id);
  t:=clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object('ok',true,'clothes_id',id,'category',category,'color',color,'deletion_token',deletion_token,'undo_until',undo_until,'server_now',t) order by deleted_at desc),'[]') into r
    from clothes where user_id=p_user_id and deleted_at is not null and deletion_token is not null and undo_until>t and image_purge_started_at is null;
  return jsonb_build_object('items',r,'server_now',t);
end $$;

-- A claim permanently closes Undo before touching R2. It also fences old workers.
-- Old jobs containing only image_key are safe only for pre-Undo deleted rows.
create function public.claim_clothes_image_purge(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$ declare j generation_jobs; v clothes; owner_id uuid; begin
  select user_id into owner_id from generation_jobs where id=p_job_id;
  if not found then raise exception 'LEASE_LOST'; end if;
  perform lock_active_user(owner_id);
  select * into j from generation_jobs where id=p_job_id and job_type='image_delete' and status='running'
    and lease_token=p_lease_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'LEASE_LOST'; end if;
  select * into v from clothes where user_id=j.user_id and image_key=j.payload->>'image_key' for update;
  if not found or v.deleted_at is null then return null; end if;
  if v.image_key not like 'private/'||j.user_id::text||'/%' then raise exception 'INVALID_IMAGE_OWNER'; end if;
  if j.payload?'deletion_token' then
    if v.id::text is distinct from j.payload->>'clothes_id' or v.deletion_token::text is distinct from j.payload->>'deletion_token' then return null; end if;
    if v.undo_until is null or v.undo_until>clock_timestamp() then raise exception 'UNDO_NOT_EXPIRED'; end if;
  elsif v.deletion_token is not null then return null;
  end if;
  -- Waiting for a row lock must not extend an expired job lease.
  if j.lease_until<=clock_timestamp() then raise exception 'LEASE_LOST'; end if;
  update clothes set image_purge_started_at=coalesce(image_purge_started_at,clock_timestamp()) where id=v.id;
  return jsonb_build_object('image_key',v.image_key);
end $$;

do $$ declare fn regprocedure; begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array['delete_clothes','restore_clothes','list_clothes_deletions','claim_clothes_image_purge'])
  loop
    execute format('revoke execute on function %s from public, anon, authenticated',fn);
    execute format('grant execute on function %s to service_role',fn);
  end loop;
end $$;
commit;
