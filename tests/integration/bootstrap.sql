-- Isolated local integration only. GoTrue owns/migrates auth.users itself.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login noinherit password 'outfit-local-test-only';
grant anon,authenticated,service_role to authenticator;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
grant usage on schema auth,public to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
