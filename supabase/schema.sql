-- ==========================================================
-- ORTOSTEP — base de datos en Supabase
-- Ejecuta este archivo completo en: Supabase → SQL Editor → New query → Run
-- Es seguro ejecutarlo más de una vez.
-- ==========================================================

-- 1) Pedidos ------------------------------------------------
create table if not exists public.pedidos (
  id          uuid primary key,
  folio       text unique not null,
  creado      timestamptz not null default now(),
  estado      text not null default 'nuevo',   -- nuevo, en_revision, pagado, en_produccion, enviado, entregado, cancelado
  producto    text not null,
  precio_mxn  integer not null,
  total_mxn   integer not null,
  gratis      boolean not null default false,
  cupon       text,
  nombre      text,
  correo      text,
  whatsapp    text,
  datos       jsonb not null,                  -- todo el expediente (respuestas)
  archivos    jsonb not null,                  -- rutas de videos y fotos en Storage
  notas       text
);
-- Con RLS activado y SIN políticas, nadie puede leer ni escribir esta tabla desde la página.
-- Solo tú (desde el panel de Supabase) y las funciones de abajo.
alter table public.pedidos enable row level security;

-- 2) Códigos de promoción (100 % de descuento, un solo uso) ----
create table if not exists public.cupones (
  codigo    text primary key,
  activo    boolean not null default true,
  usado     boolean not null default false,
  usado_en  timestamptz,
  pedido    uuid references public.pedidos(id),
  nota      text
);
alter table public.cupones enable row level security;

-- 3) ¿El código es válido? (no lo gasta) ---------------------
create or replace function public.validar_cupon(p_codigo text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from cupones
    where codigo = upper(regexp_replace(coalesce(p_codigo, ''), '\s', '', 'g'))
      and activo and not usado
  );
$$;

-- 4) Registrar pedido (el precio lo pone el servidor, no la página) --
create or replace function public.crear_pedido(
  p_id uuid, p_producto text, p_datos jsonb, p_archivos jsonb, p_cupon text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_precio integer;
  v_gratis boolean := false;
  v_folio  text;
  v_codigo text := nullif(upper(regexp_replace(coalesce(p_cupon, ''), '\s', '', 'g')), '');
  v_prev   record;
begin
  -- Reintento del mismo pedido: devuelve lo ya registrado.
  select folio, gratis, total_mxn into v_prev from pedidos where id = p_id;
  if found then
    return jsonb_build_object('folio', v_prev.folio, 'gratis', v_prev.gratis, 'total', v_prev.total_mxn);
  end if;

  v_precio := case p_producto
    when 'clasica'    then 1798
    when 'deportiva'  then 1998
    when 'sandalia'   then 2798
    when 'bostoniana' then 2858
  end;
  if v_precio is null then raise exception 'Producto no válido'; end if;
  if p_datos is null or coalesce(p_datos->>'nombre', '') = '' then raise exception 'Faltan datos'; end if;
  if pg_column_size(p_datos) > 200000 then raise exception 'Datos demasiado grandes'; end if;

  v_folio := 'OS-' || to_char(now() at time zone 'America/Mexico_City', 'YYMMDD') || '-' ||
             upper(substr(replace(p_id::text, '-', ''), 1, 5));

  insert into pedidos (id, folio, producto, precio_mxn, total_mxn, nombre, correo, whatsapp, datos, archivos)
  values (p_id, v_folio, p_producto, v_precio, v_precio,
          p_datos->>'nombre', p_datos->>'correo', p_datos->>'whatsapp', p_datos, coalesce(p_archivos, '{}'::jsonb));

  if v_codigo is not null then
    update cupones set usado = true, usado_en = now(), pedido = p_id
    where codigo = v_codigo and activo and not usado;
    if found then
      v_gratis := true;
      update pedidos set gratis = true, cupon = v_codigo, total_mxn = 0 where id = p_id;
    end if;
  end if;

  return jsonb_build_object('folio', v_folio, 'gratis', v_gratis, 'total', case when v_gratis then 0 else v_precio end);
end;
$$;

revoke all on function public.validar_cupon(text) from public;
revoke all on function public.crear_pedido(uuid, text, jsonb, jsonb, text) from public;
grant execute on function public.validar_cupon(text) to anon, authenticated;
grant execute on function public.crear_pedido(uuid, text, jsonb, jsonb, text) to anon, authenticated;

-- 5) Almacenamiento privado para videos y fotos ---------------
-- 50 MB por archivo (máximo del plan gratis). Solo videos e imágenes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expedientes', 'expedientes', false, 52428800, array['video/*', 'image/*'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- La página solo puede SUBIR archivos nuevos. No puede listarlos, verlos, cambiarlos ni borrarlos.
drop policy if exists "ortostep: subir expedientes" on storage.objects;
create policy "ortostep: subir expedientes"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'expedientes');

-- 6) Tus códigos ------------------------------------------------
-- Los códigos NO se guardan en este archivo (el repositorio es público).
-- Créalos desde Supabase → Table Editor → cupones → Insert row, o con SQL:
-- Para crear un código nuevo:
--   insert into public.cupones (codigo, nota) values ('ORTO-XXXXXX', 'para quién es');
-- Para ver los pedidos más recientes:
--   select folio, creado, estado, nombre, whatsapp, producto, total_mxn, cupon from public.pedidos order by creado desc;
