-- ==========================================================
-- ORTOSTEP — v3: integración con el sistema de diseño de plantillas
-- Ejecuta este archivo en Supabase → SQL Editor → New query → Run
-- (después de schema.sql). Incluye todo lo de schema_v2_disenos.sql.
-- Es seguro ejecutarlo más de una vez: cada ejecución deja la versión vigente.
--
-- Flujo (decisiones del usuario, 2026-11-24):
--   1. El programa de extracción deja la ficha:      disenos.estado = 'ficha_lista'
--      Con banderas queda en 'requiere_revision'; el ortesista la libera con
--      liberar_ficha() (o cambiando el estado en el Table Editor).
--   2. El sistema de plantillas la toma:             tomar_para_diseno()     → 'en_cola_diseno'
--      crea el caso y lo confirma:                   confirmar_caso_diseno() (guarda caso_externo)
--      Si se cae antes de confirmar, a los 15 min la ficha se vuelve a entregar.
--   3. Validada por la diseñadora, sube los 2 STL a disenos/{id_pedido}/v{version}/stl/
--      y llama:                                      registrar_stl()         → 'stl_validado'  (pedido: 'stl_listo')
--      Si reabre un caso ya validado:                retirar_stl()           → 'en_cola_diseno' (sin STL)
--      Si no se puede diseñar:                       marcar_diseno_rechazado() → 'rechazado'
--   Las funciones solo funcionan con la clave SECRETA (servidor), nunca desde la página.
-- ==========================================================

-- ---------- Tabla y bucket de diseños (no hace nada si ya existen) ----------
create table if not exists public.disenos (
  id                 bigint generated always as identity primary key,
  pedido             uuid not null references public.pedidos(id) on delete cascade,
  version            integer not null default 1,
  creado             timestamptz not null default now(),
  estado             text not null,
  requiere_revision  boolean not null default true,
  banderas           jsonb not null default '[]'::jsonb,
  ficha              jsonb not null,
  archivos           jsonb not null default '{}'::jsonb,
  diseno_log         jsonb,
  aprobado_por       text,
  aprobado_en        timestamptz,
  notas              text,
  unique (pedido, version)
);
alter table public.disenos enable row level security;
create index if not exists disenos_estado_idx on public.disenos (estado);

insert into storage.buckets (id, name, public, file_size_limit)
values ('disenos', 'disenos', false, 52428800)
on conflict (id) do update set public = false;

alter table public.disenos add column if not exists caso_externo          text;        -- caso en el sistema de plantillas
alter table public.disenos add column if not exists tomado_en             timestamptz;
alter table public.disenos add column if not exists stl                   jsonb;       -- {"L": "ruta", "R": "ruta"} en el bucket disenos
alter table public.disenos add column if not exists validado_por          text;
alter table public.disenos add column if not exists validado_en           timestamptz;
alter table public.disenos add column if not exists estado_pedido_previo  text;        -- estado del pedido antes de 'stl_listo'

-- Firmas anteriores (sin versión explícita): se eliminan.
drop function if exists public.registrar_stl(uuid, jsonb, text, text);
drop function if exists public.marcar_diseno_rechazado(uuid, text, text);

-- ---------- 1. Tomar fichas (atómico) ----------
-- Entrega las 'ficha_lista' y, además, las tomadas hace más de 15 minutos que nunca
-- se confirmaron (el sistema se cayó antes de crear el caso). Excluye pedidos cancelados.
create or replace function public.tomar_para_diseno(p_limite integer default 10)
returns table (pedido uuid, folio text, version integer, para_diseno text, medidas text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with elegidas as (
    select d.id from disenos d
    join pedidos p on p.id = d.pedido
    where p.estado <> 'cancelado'
      and (d.estado = 'ficha_lista'
           or (d.estado = 'en_cola_diseno' and d.caso_externo is null and d.tomado_en < now() - interval '15 minutes'))
    order by d.creado
    limit greatest(1, least(coalesce(p_limite, 10), 50))
    for update of d skip locked
  ), marcadas as (
    update disenos d set estado = 'en_cola_diseno', tomado_en = now()
    from elegidas e where d.id = e.id
    returning d.pedido, d.version, d.archivos
  )
  select m.pedido, p.folio, m.version, m.archivos->>'para_diseno', m.archivos->>'medidas'
  from marcadas m join pedidos p on p.id = m.pedido;
end;
$$;

-- ---------- 1b. Confirmar que el caso se creó ----------
create or replace function public.confirmar_caso_diseno(p_pedido uuid, p_version integer, p_caso text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update disenos set caso_externo = p_caso
  where pedido = p_pedido and version = p_version and estado = 'en_cola_diseno';
  if not found then
    raise exception 'El diseño % v% no está en cola (en_cola_diseno)', p_pedido, p_version;
  end if;
end;
$$;

-- ---------- 2/4. Registrar STL validados ----------
create or replace function public.registrar_stl(p_pedido uuid, p_version integer, p_stl jsonb,
                                                p_caso text default null, p_validado_por text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_diseno text;
  v_pedido text;
begin
  if p_stl is null
     or coalesce(jsonb_typeof(p_stl->'L'), '') <> 'string'
     or coalesce(jsonb_typeof(p_stl->'R'), '') <> 'string' then
    raise exception 'p_stl debe traer "L" y "R" como texto';
  end if;
  select d.estado into v_diseno from disenos d
  where d.pedido = p_pedido and d.version = p_version for update;
  if not found then
    raise exception 'No existe el diseño % v%', p_pedido, p_version;
  end if;
  if v_diseno not in ('en_cola_diseno', 'stl_validado') then
    raise exception 'El diseño % v% está en estado %; no se pueden registrar STL', p_pedido, p_version, v_diseno;
  end if;
  select pe.estado into v_pedido from pedidos pe where pe.id = p_pedido for update;
  update disenos d set
    estado = 'stl_validado', stl = p_stl,
    caso_externo = coalesce(p_caso, d.caso_externo),
    validado_por = p_validado_por, validado_en = now(),
    estado_pedido_previo = case when v_diseno = 'en_cola_diseno' and v_pedido <> 'stl_listo'
                                then v_pedido else d.estado_pedido_previo end
  where d.pedido = p_pedido and d.version = p_version;
  if v_pedido not in ('cancelado', 'en_produccion', 'enviado', 'entregado') then
    update pedidos set estado = 'stl_listo' where id = p_pedido;
  end if;
end;
$$;

-- ---------- 3. Retirar STL (caso reabierto) ----------
create or replace function public.retirar_stl(p_pedido uuid, p_version integer, p_motivo text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  update disenos set estado = 'en_cola_diseno', stl = null, validado_por = null, validado_en = null, notas = p_motivo
  where pedido = p_pedido and version = p_version and estado = 'stl_validado'
  returning estado_pedido_previo into v_prev;
  if not found then
    raise exception 'El diseño % v% no tiene STL validados', p_pedido, p_version;
  end if;
  update pedidos set estado = coalesce(v_prev, 'ficha_lista') where id = p_pedido and estado = 'stl_listo';
end;
$$;

-- ---------- 2. Rechazar (no se puede diseñar) ----------
create or replace function public.marcar_diseno_rechazado(p_pedido uuid, p_version integer, p_motivo text,
                                                          p_caso text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update disenos set estado = 'rechazado', stl = null, notas = p_motivo, caso_externo = coalesce(p_caso, caso_externo)
  where pedido = p_pedido and version = p_version;
  if not found then
    raise exception 'No existe el diseño % v%', p_pedido, p_version;
  end if;
  update pedidos set estado = 'requiere_revision'
  where id = p_pedido and estado not in ('cancelado', 'en_produccion', 'enviado', 'entregado');
end;
$$;

-- ---------- Liberar una ficha con banderas (la usa el ortesista) ----------
-- Desde el SQL Editor:  select liberar_ficha('<id del pedido>', 1, 'Nombre del ortesista');
create or replace function public.liberar_ficha(p_pedido uuid, p_version integer, p_ortesista text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update disenos set estado = 'ficha_lista', requiere_revision = false, aprobado_por = p_ortesista, aprobado_en = now()
  where pedido = p_pedido and version = p_version and estado in ('requiere_revision', 'rechazado');
  if not found then
    raise exception 'El diseño % v% no está en requiere_revision ni rechazado', p_pedido, p_version;
  end if;
  update pedidos set estado = 'ficha_lista' where id = p_pedido and estado = 'requiere_revision';
end;
$$;

-- ---------- Permisos de tablas para el servidor (clave secreta = service_role) ----------
-- En este proyecto las tablas nuevas no reciben permisos automáticos, así que se dan aquí.
-- La página (anon) sigue SIN acceso a las tablas: solo usa las funciones crear_pedido y validar_cupon.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.pedidos, public.disenos, public.cupones to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------- Permisos de funciones: solo el servidor (clave secreta) ----------
revoke all on function public.tomar_para_diseno(integer)                         from public, anon, authenticated;
revoke all on function public.confirmar_caso_diseno(uuid, integer, text)          from public, anon, authenticated;
revoke all on function public.registrar_stl(uuid, integer, jsonb, text, text)     from public, anon, authenticated;
revoke all on function public.retirar_stl(uuid, integer, text)                    from public, anon, authenticated;
revoke all on function public.marcar_diseno_rechazado(uuid, integer, text, text)  from public, anon, authenticated;
revoke all on function public.liberar_ficha(uuid, integer, text)                  from public, anon, authenticated;
grant execute on function public.tomar_para_diseno(integer)                        to service_role;
grant execute on function public.confirmar_caso_diseno(uuid, integer, text)         to service_role;
grant execute on function public.registrar_stl(uuid, integer, jsonb, text, text)    to service_role;
grant execute on function public.retirar_stl(uuid, integer, text)                   to service_role;
grant execute on function public.marcar_diseno_rechazado(uuid, integer, text, text) to service_role;
grant execute on function public.liberar_ficha(uuid, integer, text)                 to service_role;
