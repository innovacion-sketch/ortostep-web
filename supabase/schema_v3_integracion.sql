-- ==========================================================
-- ORTOSTEP — v3: integración con el sistema de diseño de plantillas
-- Ejecuta este archivo en Supabase → SQL Editor → New query → Run
-- (después de schema.sql). Incluye todo lo de schema_v2_disenos.sql, así que no hace
-- falta ejecutar ese antes. Es seguro ejecutarlo más de una vez.
--
-- Flujo acordado (decisiones del usuario, 2026-11-24):
--   1. El programa de extracción deja la ficha:        disenos.estado = 'ficha_lista'
--      (si tiene banderas queda en 'requiere_revision'; el ortesista la revisa y,
--       si procede, la cambia a 'ficha_lista' desde el Table Editor).
--   2. El sistema de plantillas la toma de aquí:        tomar_para_diseno()  → 'en_cola_diseno'
--      lee disenos/{id_pedido}/v1/para_diseno.json y medidas.json del bucket «disenos»
--      y crea el caso en la cola de revisión de las diseñadoras.
--   3. Validada por la diseñadora, sube los 2 STL a disenos/{id_pedido}/v1/stl/
--      y llama registrar_stl()                            → 'stl_validado'  (pedido: 'stl_listo')
--      Si la diseñadora lo rechaza: marcar_diseno_rechazado() → 'rechazado'.
--   Las funciones solo se pueden usar con la clave SECRETA (servidor), nunca desde la página.
-- ==========================================================

-- ---------- Lo de v2: tabla y bucket de diseños (no hace nada si ya existen) ----------
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

-- ---------- v3: integración ----------
alter table public.disenos add column if not exists caso_externo   text;          -- id del caso en el sistema de plantillas
alter table public.disenos add column if not exists tomado_en      timestamptz;
alter table public.disenos add column if not exists stl            jsonb;         -- {"L": "ruta", "R": "ruta"} en el bucket disenos
alter table public.disenos add column if not exists validado_por   text;
alter table public.disenos add column if not exists validado_en    timestamptz;

-- Toma (de forma atómica) hasta p_limite fichas listas y las marca como en cola.
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
    where d.estado = 'ficha_lista'
    order by d.creado
    limit greatest(1, least(p_limite, 50))
    for update skip locked
  ), marcadas as (
    update disenos d set estado = 'en_cola_diseno', tomado_en = now()
    from elegidas e where d.id = e.id
    returning d.pedido, d.version, d.archivos
  )
  select m.pedido, p.folio, m.version, m.archivos->>'para_diseno', m.archivos->>'medidas'
  from marcadas m join pedidos p on p.id = m.pedido;
end;
$$;

-- Registra los STL validados por la diseñadora.
create or replace function public.registrar_stl(p_pedido uuid, p_stl jsonb, p_caso text default null, p_validado_por text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update disenos set estado = 'stl_validado', stl = p_stl, caso_externo = coalesce(p_caso, caso_externo),
         validado_por = p_validado_por, validado_en = now()
  where pedido = p_pedido and version = (select max(version) from disenos where pedido = p_pedido);
  if not found then raise exception 'No existe diseño para el pedido %', p_pedido; end if;
  update pedidos set estado = 'stl_listo' where id = p_pedido;
end;
$$;

-- Marca un diseño como rechazado por la diseñadora (con motivo).
create or replace function public.marcar_diseno_rechazado(p_pedido uuid, p_motivo text, p_caso text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update disenos set estado = 'rechazado', notas = p_motivo, caso_externo = coalesce(p_caso, caso_externo)
  where pedido = p_pedido and version = (select max(version) from disenos where pedido = p_pedido);
  update pedidos set estado = 'requiere_revision' where id = p_pedido;
end;
$$;

-- Solo el servidor (clave secreta). La página (clave pública) no puede llamarlas.
revoke all on function public.tomar_para_diseno(integer) from public, anon, authenticated;
revoke all on function public.registrar_stl(uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.marcar_diseno_rechazado(uuid, text, text) from public, anon, authenticated;
grant execute on function public.tomar_para_diseno(integer) to service_role;
grant execute on function public.registrar_stl(uuid, jsonb, text, text) to service_role;
grant execute on function public.marcar_diseno_rechazado(uuid, text, text) to service_role;
