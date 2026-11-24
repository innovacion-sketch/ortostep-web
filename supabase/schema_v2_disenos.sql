-- ==========================================================
-- ORTOSTEP — v2: fichas y diseños de plantillas
-- Ejecuta este archivo en Supabase → SQL Editor → New query → Run
-- (después de schema.sql). Es seguro ejecutarlo más de una vez.
-- ==========================================================

-- Estados del pedido que usa el programa de extracción:
--   nuevo → ficha_lista | requiere_revision | disenado | error_ficha
--   (y los que ya tenías: pagado, en_produccion, enviado, entregado, cancelado)

create table if not exists public.disenos (
  id                 bigint generated always as identity primary key,
  pedido             uuid not null references public.pedidos(id) on delete cascade,
  version            integer not null default 1,
  creado             timestamptz not null default now(),
  estado             text not null,                 -- ficha_lista, requiere_revision, disenado, aprobado, rechazado
  requiere_revision  boolean not null default true,
  banderas           jsonb not null default '[]'::jsonb,
  ficha              jsonb not null,                -- medidas, métricas de marcha y diseño sugerido (sin contornos)
  archivos           jsonb not null default '{}'::jsonb, -- rutas en el bucket "disenos" (ficha.json, reporte.html, STL…)
  diseno_log         jsonb,
  aprobado_por       text,
  aprobado_en        timestamptz,
  notas              text,
  unique (pedido, version)
);
-- Igual que pedidos: sin políticas = nadie lo lee desde la página. Solo el panel y la clave secreta del taller.
alter table public.disenos enable row level security;

create index if not exists disenos_estado_idx on public.disenos (estado);

-- Bucket privado para fichas, reportes y archivos 3D.
insert into storage.buckets (id, name, public, file_size_limit)
values ('disenos', 'disenos', false, 52428800)
on conflict (id) do update set public = false;
