-- Dedicated PFMP tables. No existing project table is changed.
-- Only the authenticated Edge Function can call these RPCs. Browser roles have no table access.
create table public.pfmp_teachers(email text primary key check(email=lower(email)), user_id uuid unique, enabled boolean not null default true);
create table public.pfmp_students(id text primary key, name text not null, class_name text not null, email text not null default '', active boolean not null default true, auth_user_id uuid unique, created_at timestamptz not null default now());
create unique index pfmp_students_email_unique on public.pfmp_students(lower(email)) where email<>'';
create unique index pfmp_students_name_class_unique on public.pfmp_students(name,class_name);
create table public.pfmp_companies(id text primary key, fingerprint text not null unique, data jsonb not null check(jsonb_typeof(data)='object'));
create table public.pfmp_deleted_companies(fingerprint text primary key, deleted_at timestamptz not null default now());
create table public.pfmp_reports(id text primary key, company_id text not null references public.pfmp_companies(id) on delete cascade, student_id text not null references public.pfmp_students(id), status text not null check(status in ('À contacter','En attente','Accepté','Refusé','À relancer')), date date not null, method text not null default '', contact text not null default '', notes text not null default '', start_date date, end_date date, updated_at timestamptz not null default now(), check(end_date is null or start_date is null or end_date>=start_date));
create index pfmp_reports_company_idx on public.pfmp_reports(company_id);
create index pfmp_reports_student_idx on public.pfmp_reports(student_id);
create table public.pfmp_reservations(company_id text primary key references public.pfmp_companies(id) on delete cascade, student_id text not null references public.pfmp_students(id), report_id text not null unique references public.pfmp_reports(id) on delete cascade);
create index pfmp_reservations_student_idx on public.pfmp_reservations(student_id);
create table public.pfmp_invites(student_id text primary key references public.pfmp_students(id) on delete cascade, email text not null unique, code_hash text not null, expires_at timestamptz not null, pending_user_id uuid, claimed_at timestamptz, previous_user_id uuid);
create table public.pfmp_signup_attempts(email text primary key, failures integer not null default 0, locked_until timestamptz);
create table public.pfmp_metadata(id boolean primary key default true check(id), revision bigint not null default 0, summary jsonb not null default '{}');
insert into public.pfmp_metadata(id) values(true);

-- Revoke explicit browser privileges in addition to enabling RLS.
do $$ declare t text; begin
 foreach t in array array['pfmp_teachers','pfmp_students','pfmp_companies','pfmp_deleted_companies','pfmp_reports','pfmp_reservations','pfmp_invites','pfmp_signup_attempts','pfmp_metadata'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant select, insert, update, delete on public.%I to service_role',t);
 end loop;
end $$;
grant usage on schema auth to service_role;
grant select on auth.users,auth.sessions to service_role;

create function public.pfmp_touch() returns trigger language plpgsql set search_path='' as $$ begin
 update public.pfmp_metadata set revision=revision+1 where id=true; return null;
end $$;
do $$ declare t text; begin
 foreach t in array array['pfmp_students','pfmp_companies','pfmp_reports','pfmp_reservations','pfmp_teachers'] loop
  execute format('create trigger pfmp_changed after insert or update or delete on public.%I for each statement execute function public.pfmp_touch()',t);
 end loop;
end $$;

create function public.pfmp_request(p_action text,p_body jsonb,p_user uuid,p_email text,p_session uuid,p_aal text) returns jsonb language plpgsql set search_path='' as $$
declare teacher boolean; pupil public.pfmp_students; s public.pfmp_students; c public.pfmp_companies; r public.pfmp_reports; reserved public.pfmp_reservations; v jsonb; result jsonb; item_id text; count_added integer:=0; count_updated integer:=0; count_duplicate integer:=0; current_revision bigint; old_user uuid;
begin
 -- A checked user AND a live session are required, including after access reset.
 if p_user is null or not exists(select 1 from auth.sessions where id=p_session and user_id=p_user) then raise exception 'Session expirée.' using errcode='28000'; end if;
 if not exists(select 1 from auth.users where id=p_user and lower(email)=lower(p_email) and email_confirmed_at is not null) then raise exception 'Adresse e-mail non confirmée.' using errcode='28000'; end if;
 select exists(select 1 from public.pfmp_teachers where email=lower(p_email) and enabled and (user_id is null or user_id=p_user)) into teacher;
 if teacher then
  if exists(select 1 from public.pfmp_teachers where email=lower(p_email) and user_id is null) then update public.pfmp_teachers set user_id=p_user where email=lower(p_email) and user_id is null;end if;
 else
  select * into pupil from public.pfmp_students where auth_user_id=p_user and lower(email)=lower(p_email) and active;
  if not found then raise exception 'Ce compte n’est pas autorisé. Utilisez le code remis par votre enseignant.' using errcode='42501'; end if;
 end if;
 if p_action='profile' then return jsonb_build_object('role',case when teacher then 'teacher' else 'student' end,'email',p_email,'name',pupil.name); end if;
 if teacher and p_aal<>'aal2' then raise exception 'Validez Authenticator pour accéder aux données.' using errcode='42501'; end if;
 select revision into current_revision from public.pfmp_metadata where id=true;
 if p_action='state' then
  if p_body->>'revision'=current_revision::text then return jsonb_build_object('unchanged',true,'revision',current_revision); end if;
  return jsonb_build_object('teacher',teacher,'user',jsonb_build_object('email',p_email),'student',case when teacher then null else to_jsonb(pupil)-'auth_user_id' end,'privateAccess',true,'revision',current_revision,
   'companies',coalesce((select jsonb_agg((x.data-'raw'-'commentaire')||jsonb_build_object('id',x.id,'reserved',z.company_id is not null,'reservedStudentId',case when teacher then z.student_id else null end) order by x.data->>'raisonSociale') from public.pfmp_companies x left join public.pfmp_reservations z on z.company_id=x.id where teacher or z.company_id is null or z.student_id=pupil.id),'[]'),
   'students',coalesce((select jsonb_agg(to_jsonb(x)-'auth_user_id' order by x.class_name,x.name) from public.pfmp_students x where x.active and (teacher or x.id=pupil.id)),'[]'),
   'reports',coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from public.pfmp_reports x where teacher or x.student_id=pupil.id),'[]'),
   'summary',case when teacher then (select summary from public.pfmp_metadata where id=true) else null end);
 end if;
 if not teacher and p_action<>'reports' then raise exception 'Action réservée à l’enseignant.' using errcode='42501'; end if;
 if p_action='students' then
  for v in select value from jsonb_array_elements(case when jsonb_typeof(p_body->'students')='array' then p_body->'students' else jsonb_build_array(p_body) end) loop
   if coalesce(trim(v->>'name'),'')='' or coalesce(trim(v->>'class_name'),'')='' then raise exception 'Chaque élève doit avoir un nom et une classe.'; end if;
   if coalesce(v->>'email','')<>'' and v->>'email' !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Adresse e-mail non valide.'; end if;
   select * into s from public.pfmp_students where id=v->>'id';
   if found then
    if s.email<>lower(coalesce(v->>'email','')) and s.auth_user_id is not null then raise exception 'Réinitialisez d’abord l’accès avant de changer cet e-mail.'; end if;
    if s.email<>lower(coalesce(v->>'email','')) then delete from public.pfmp_invites where student_id=s.id; end if;
    update public.pfmp_students set name=left(trim(v->>'name'),180),class_name=left(trim(v->>'class_name'),80),email=lower(trim(coalesce(v->>'email',''))),active=true where id=s.id;
   else
    if exists(select 1 from public.pfmp_students where name=trim(v->>'name') and class_name=trim(v->>'class_name')) then continue; end if;
    insert into public.pfmp_students(id,name,class_name,email) values(gen_random_uuid()::text,left(trim(v->>'name'),180),left(trim(v->>'class_name'),80),lower(trim(coalesce(v->>'email',''))));
   end if;
   count_added:=count_added+1;
  end loop;
  return jsonb_build_object('added',count_added);
 elsif p_action='companies' then
  for v in select value from jsonb_array_elements(p_body->'companies') loop
   if coalesce(v->>'raisonSociale','')='' or coalesce(v->>'fingerprint','')='' then raise exception 'Entreprise non valide.'; end if;
   select * into c from public.pfmp_companies where id=v->>'id';
   if found then
    if (c.data->>'adresse' is distinct from v->>'adresse' or c.data->>'codePostal' is distinct from v->>'codePostal' or c.data->>'ville' is distinct from v->>'ville') and c.data->'lat' is not distinct from v->'lat' and c.data->'lon' is not distinct from v->'lon' then v:=v||jsonb_build_object('lat',null,'lon',null,'geoPrecision',null);end if;
    update public.pfmp_companies set data=(v-'fingerprint'-'raw'-'reserved'-'reservedStudentId'),fingerprint=v->>'fingerprint' where id=c.id;
    count_updated:=count_updated+1;
   else
    if exists(select 1 from public.pfmp_deleted_companies where fingerprint=v->>'fingerprint') or exists(select 1 from public.pfmp_companies where fingerprint=v->>'fingerprint') then count_duplicate:=count_duplicate+1;continue;end if;
    insert into public.pfmp_companies(id,fingerprint,data) values(v->>'id',v->>'fingerprint',v-'fingerprint'-'raw'-'reserved'-'reservedStudentId');count_added:=count_added+1;
   end if;
  end loop;
  return jsonb_build_object('added',count_added,'updated',count_updated,'duplicates',count_duplicate);
 elsif p_action='reports' then
  if teacher then select * into s from public.pfmp_students where id=p_body->>'studentId' and active;else s:=pupil;end if;
  if s.id is null then raise exception 'Élève inconnu.';end if;
  if not teacher and coalesce(p_body->>'studentId',s.id)<>s.id then raise exception 'Compte rendu inaccessible.' using errcode='42501';end if;
  -- Serialize competing applications on the same company inside this transaction.
  select * into c from public.pfmp_companies where id=p_body->>'companyId' for update;
  if not found then raise exception 'Entreprise inconnue.';end if;
  select * into r from public.pfmp_reports where id=p_body->>'id';
  if found and (r.student_id<>s.id or r.company_id<>c.id) then raise exception 'Compte rendu inaccessible.' using errcode='42501';end if;
  item_id:=coalesce(r.id,gen_random_uuid()::text);
  select * into reserved from public.pfmp_reservations where company_id=c.id;
  if reserved.company_id is not null and (reserved.student_id<>s.id or (p_body->>'status'='Accepté' and reserved.report_id<>item_id)) then raise exception 'Cette entreprise a déjà accepté un élève.' using errcode='23505';end if;
  insert into public.pfmp_reports(id,company_id,student_id,status,date,method,contact,notes,start_date,end_date)
  values(item_id,c.id,s.id,p_body->>'status',(p_body->>'date')::date,left(coalesce(p_body->>'method',''),100),left(coalesce(p_body->>'contact',''),500),left(coalesce(p_body->>'notes',''),5000),nullif(p_body->>'startDate','')::date,nullif(p_body->>'endDate','')::date)
  on conflict(id) do update set status=excluded.status,date=excluded.date,method=excluded.method,contact=excluded.contact,notes=excluded.notes,start_date=excluded.start_date,end_date=excluded.end_date,updated_at=now();
  if p_body->>'status'='Accepté' then insert into public.pfmp_reservations values(c.id,s.id,item_id) on conflict(company_id) do nothing;
  else delete from public.pfmp_reservations where company_id=c.id and report_id=item_id;end if;
  return jsonb_build_object('id',item_id,'status',p_body->>'status');
 elsif p_action='release' then
  perform 1 from public.pfmp_companies where id=p_body->>'companyId' for update;
  select * into reserved from public.pfmp_reservations where company_id=p_body->>'companyId';
  if found then update public.pfmp_reports set status='À relancer',updated_at=now() where id=reserved.report_id;delete from public.pfmp_reservations where company_id=reserved.company_id;end if;
  return jsonb_build_object('released',reserved.company_id is not null);
 elsif p_action='delete-companies' then
  if p_body->>'confirm'<>'SUPPRIMER' or jsonb_array_length(p_body->'ids')>5000 then raise exception 'Confirmez la suppression.';end if;
  insert into public.pfmp_deleted_companies(fingerprint) select fingerprint from public.pfmp_companies where id in(select jsonb_array_elements_text(p_body->'ids')) on conflict do nothing;
  delete from public.pfmp_companies where id in(select jsonb_array_elements_text(p_body->'ids'));
  get diagnostics count_added=row_count;return jsonb_build_object('deleted',count_added);
 elsif p_action='invite' then
  select * into s from public.pfmp_students where id=p_body->>'studentId' and active for update;
  if not found or s.email='' then raise exception 'Enregistrez l’e-mail de l’élève avant de générer le code.';end if;
  if exists(select 1 from public.pfmp_teachers where email=s.email) then raise exception 'Une adresse enseignant ne peut pas devenir un compte élève.';end if;
  if coalesce((p_body->>'reset')::boolean,false) then
   old_user:=coalesce(s.auth_user_id,(select previous_user_id from public.pfmp_invites where student_id=s.id));
   update public.pfmp_students set auth_user_id=null where id=s.id;
  end if;
  insert into public.pfmp_invites(student_id,email,code_hash,expires_at,previous_user_id) values(s.id,s.email,p_body->>'codeHash',now()+interval '7 days',old_user) on conflict(student_id) do update set email=excluded.email,code_hash=excluded.code_hash,expires_at=excluded.expires_at,pending_user_id=null,claimed_at=null,previous_user_id=coalesce(excluded.previous_user_id,pfmp_invites.previous_user_id);
  delete from public.pfmp_signup_attempts where email=s.email;
  return jsonb_build_object('email',s.email,'expires',now()+interval '7 days','oldUser',old_user);
 else raise exception 'Action inconnue.';end if;
end $$;

create function public.pfmp_signup_claim(p_email text,p_hash text,p_user uuid) returns jsonb language plpgsql set search_path='' as $$
declare attempt public.pfmp_signup_attempts; invitation public.pfmp_invites; s public.pfmp_students;
begin
 insert into public.pfmp_signup_attempts(email) values(lower(p_email)) on conflict do nothing;
 select * into attempt from public.pfmp_signup_attempts where email=lower(p_email) for update;
 if attempt.locked_until>now() then return jsonb_build_object('error','Trop d’essais. Réessayez dans 10 minutes.');end if;
 select * into invitation from public.pfmp_invites where email=lower(p_email) for update;
 if invitation.student_id is null or invitation.code_hash<>p_hash or invitation.expires_at<now() or invitation.claimed_at is not null then
  update public.pfmp_signup_attempts set failures=case when locked_until<now() then 1 else failures+1 end,locked_until=case when failures>=4 then now()+interval '10 minutes' else null end where email=lower(p_email);
  return jsonb_build_object('error','Code incorrect, expiré ou déjà utilisé.');
 end if;
 select * into s from public.pfmp_students where id=invitation.student_id and active and email=lower(p_email);
 if s.id is null or s.auth_user_id is not null then return jsonb_build_object('error','Cet accès nécessite l’intervention de votre enseignant.');end if;
 update public.pfmp_invites set pending_user_id=p_user,claimed_at=now() where student_id=s.id;
 return jsonb_build_object('studentId',s.id,'name',s.name);
end $$;
create function public.pfmp_signup_finish(p_email text,p_user uuid,p_success boolean) returns boolean language plpgsql set search_path='' as $$
declare invitation public.pfmp_invites;
begin
 select * into invitation from public.pfmp_invites where email=lower(p_email) and pending_user_id=p_user for update;
 if not found then return false;end if;
 if not p_success then update public.pfmp_invites set claimed_at=null,pending_user_id=null where student_id=invitation.student_id;return false;end if;
 if not exists(select 1 from auth.users where id=p_user and lower(email)=lower(p_email) and email_confirmed_at is not null) then raise exception 'Compte non confirmé.';end if;
 update public.pfmp_students set auth_user_id=p_user where id=invitation.student_id and active and email=lower(p_email) and auth_user_id is null;
 if not found then raise exception 'Invitation modifiée. Demandez un nouveau code.';end if;
 delete from public.pfmp_invites where student_id=invitation.student_id;
 delete from public.pfmp_signup_attempts where email=lower(p_email);
 return true;
end $$;

revoke all on function public.pfmp_touch() from public,anon,authenticated;
revoke all on function public.pfmp_request(text,jsonb,uuid,text,uuid,text) from public,anon,authenticated;
revoke all on function public.pfmp_signup_claim(text,text,uuid) from public,anon,authenticated;
revoke all on function public.pfmp_signup_finish(text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.pfmp_request(text,jsonb,uuid,text,uuid,text) to service_role;
grant execute on function public.pfmp_signup_claim(text,text,uuid) to service_role;
grant execute on function public.pfmp_signup_finish(text,uuid,boolean) to service_role;
