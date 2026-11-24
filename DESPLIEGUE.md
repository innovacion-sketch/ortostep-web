# Despliegue en el VPS (Easypanel)

Son dos apps en el mismo proyecto de Easypanel, ambas desde este repositorio de GitHub (`innovacion-sketch/ortostep-web`, rama `main`).

| App | Qué hace | Construcción | Puerto | Dominio |
|---|---|---|---|---|
| `ortostep-web` | La página (sitio estático con nginx) | Ruta `/`, `Dockerfile` | 80 | `ortostep.com.mx` (con HTTPS) |
| `ortostep-extraccion` | Programa que convierte cada pedido en ficha de diseño | Ruta `/worker`, `Dockerfile` | ninguno | ninguno |

## 1. La página

1. En Easypanel → tu proyecto → **+ Service → App**. Nombre: `ortostep-web`.
2. **Source → GitHub**: repositorio `innovacion-sketch/ortostep-web`, rama `main`, **Build Path** `/`.
3. **Build → Dockerfile**: archivo `Dockerfile`.
4. **Domains → Add Domain**: `ortostep.com.mx` (y `www.ortostep.com.mx` si lo usas), puerto **80**, HTTPS activado.
5. **Deploy**. Comprueba que `https://ortostep.com.mx/salud` responda `ok`.
6. En tu proveedor de dominio, apunta `ortostep.com.mx` (registro A) a la IP del VPS. Easypanel saca el certificado HTTPS solo. La cámara del celular **requiere HTTPS**.
7. Cuando el dominio funcione, apaga la copia de GitHub Pages para no tener dos páginas: GitHub → Settings → Pages → *Unpublish site*.

## 2. El programa de extracción

1. **+ Service → App**. Nombre: `ortostep-extraccion`.
2. **Source → GitHub**: el mismo repositorio, rama `main`, **Build Path** `/worker`.
3. **Build → Dockerfile**: archivo `Dockerfile`. La construcción corre las pruebas y descarga el modelo de pose; si algo falla, no se despliega.
4. **Environment**:
   ```
   SUPABASE_URL=https://plqrtljatdmisluwurmc.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...      ← la clave SECRETA; solo aquí, nunca en la página ni en GitHub
   INTERVALO_SEGUNDOS=60
   ```
5. Sin dominio ni puerto. **Deploy**. En **Logs** debe aparecer `Vigilando pedidos nuevos cada 60 s`.
6. Recursos: con 1 vCPU y 2 GB alcanza. Cada pedido tarda de 1 a 3 minutos en analizar los 3 videos.

> Antes de esto, `supabase/schema_v2_disenos.sql` debe estar ejecutado en Supabase (ya lo hiciste).

## 3. Actualizaciones

Cada cambio que se sube a `main` se publica con **Deploy** en cada app. Para que sea automático, activa **Auto Deploy** en la pestaña Source de cada app.

## No hacer

- No pongas `DISENO_CMD` apuntando al motor del sistema de plantillas. Esa conexión será el **importador** que cree el caso en la cola de revisión de las diseñadoras, cuando lo apruebes.
- No pongas la clave secreta de Supabase en `assets/js/config.js`: ahí solo va la clave pública (publishable).
