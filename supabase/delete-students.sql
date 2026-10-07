-- Atomic deletion of explicitly selected pupils. Companies are retained.
grant delete on auth.users, auth.sessions to service_role;

create or replace function public.pfmp_delete_students(p_body jsonb,p_user uuid,p_email text,p_session uuid,p_aal text)
returns jsonb language plpgsql set search_path='' as $$
declare profile jsonb; ids text[]; user_ids uuid[]; pupil_emails text[]; deleted_count integer; reports_count integer; reservations_count integer; accounts_count integer;
begin
 profile:=public.pfmp_request('profile','{}',p_user,p_email,p_session,p_aal);
 if profile->>'role' is distinct from 'teacher' then raise exception 'Action réservée à l’enseignant.' using errcode='42501';end if;
 if p_aal is distinct from 'aal2' then raise exception 'Validez Authenticator pour supprimer des élèves.' using errcode='42501';end if;
 if p_body->>'confirm' is distinct from 'SUPPRIMER' then raise exception 'Saisissez SUPPRIMER pour confirmer la suppression définitive.';end if;
 if jsonb_typeof(p_body->'ids') is distinct from 'array' then raise exception 'Sélectionnez les élèves à supprimer.';end if;
 if jsonb_array_length(p_body->'ids')<1 or jsonb_array_length(p_body->'ids')>1000 then raise exception 'Sélectionnez entre 1 et 1 000 élèves.';end if;
 if exists(select 1 from jsonb_array_elements(p_body->'ids') v where jsonb_typeof(v) is distinct from 'string' or trim(v#>>'{}')='') then raise exception 'Sélection d’élèves non valide.';end if;
 select array_agg(distinct x) into ids from jsonb_array_elements_text(p_body->'ids') x;
 -- Stable locks prevent invitations or roster changes during this transaction.
 perform 1 from public.pfmp_students where id=any(ids) order by id for update;
 perform 1 from public.pfmp_invites where student_id=any(ids) order by student_id for update;
 select coalesce(array_agg(distinct email),'{}'::text[]) into pupil_emails from public.pfmp_students where id=any(ids) and email<>'';
 select coalesce(array_agg(distinct uid),'{}'::uuid[]) into user_ids from (
  select auth_user_id uid from public.pfmp_students where id=any(ids)
  union select pending_user_id from public.pfmp_invites where student_id=any(ids)
  union select previous_user_id from public.pfmp_invites where student_id=any(ids)
 ) linked where uid is not null;
 if p_user=any(user_ids) or exists(select 1 from public.pfmp_teachers t where t.user_id=any(user_ids) or t.email=any(pupil_emails) or exists(select 1 from auth.users u where u.id=any(user_ids) and lower(u.email)=t.email)) then
  raise exception 'Un compte enseignant ne peut pas être supprimé depuis la liste des élèves.' using errcode='42501';
 end if;
 if exists(select 1 from public.pfmp_students where auth_user_id=any(user_ids) and not(id=any(ids))) then raise exception 'Un accès est partagé avec un autre élève. Vérifiez les fiches avant suppression.';end if;
 delete from public.pfmp_reservations where student_id=any(ids);
 get diagnostics reservations_count=row_count;
 delete from public.pfmp_reports where student_id=any(ids);
 get diagnostics reports_count=row_count;
 delete from public.pfmp_invites where student_id=any(ids);
 delete from public.pfmp_signup_attempts where email=any(pupil_emails);
 delete from auth.sessions where user_id=any(user_ids);
 delete from auth.users where id=any(user_ids);
 get diagnostics accounts_count=row_count;
 delete from public.pfmp_students where id=any(ids);
 get diagnostics deleted_count=row_count;
 return jsonb_build_object('deleted',deleted_count,'reportsDeleted',reports_count,'reservationsReleased',reservations_count,'accountsDeleted',accounts_count);
end $$;

revoke all on function public.pfmp_delete_students(jsonb,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.pfmp_delete_students(jsonb,uuid,text,uuid,text) to service_role;
