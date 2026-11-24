# ORTOSTEP — sitio web

Página de venta y captura de expediente de ORTOSTEP: plantillas personalizadas impresas en 3D.
Sitio estático (HTML + CSS + JS, sin compilación). Está listo para GitHub Pages.

## Estructura

```
index.html              Página principal y flujo de compra (8 pasos)
aviso-privacidad.html   Aviso de privacidad (BORRADOR: completar)
terminos.html           Términos, garantía y devoluciones (BORRADOR: completar)
assets/css/styles.css   Estilos (modo claro y oscuro)
assets/js/config.js     ← lo único que tienes que editar para conectar la página
assets/js/app.js        Lógica: revisión de capturas, guardado, envío
assets/js/medicion.js   Mide el pie en la foto sobre la hoja (carta o A4, en el navegador)
assets/js/postura.js    Revisa con MediaPipe que en los videos se vean el cuerpo y los pies
assets/img/             Imágenes
videos/                 Videos de ejemplo (ver videos/LEEME.md)
supabase/schema.sql     Base de datos: pedidos, archivos y códigos
supabase/schema_v2_disenos.sql   Tabla y bucket de fichas de diseño
worker/                 Programa de extracción (computadora del taller): métricas de marcha,
                        ficha de diseño y exportación al sistema de plantillas. Ver worker/README.md
```

## Cómo funciona el envío de pedidos

La página tiene dos modos, según `assets/js/config.js`:

| | **Modo Supabase** (recomendado) | **Modo WhatsApp** (sin configurar) |
|---|---|---|
| Respuestas del cliente | Se guardan en la tabla `pedidos` | Se abren en WhatsApp ya escritas |
| Videos y fotos | Se suben a un almacenamiento privado | El cliente los adjunta en el chat |
| Códigos de promoción | Se validan en el servidor, son de un solo uso | Se anotan y los validas tú a mano |
| Folio | Automático (`OS-AAMMDD-XXXXX`) | Lo das tú por WhatsApp |

En ningún modo los códigos aparecen en el código de la página.

## Paso a paso: conectar Supabase (unos 10 minutos)

1. Crea una cuenta y un proyecto en [supabase.com](https://supabase.com) (el plan gratis alcanza para empezar). Región sugerida: la más cercana a México.
2. En el proyecto ve a **SQL Editor → New query**, pega todo `supabase/schema.sql` y presiona **Run**.
3. Ve a **Project Settings → API** y copia:
   - **Project URL** → `supabaseUrl`
   - La clave **anon public** (o **publishable**) → `supabaseAnonKey`
4. Pégalas en `assets/js/config.js`. Esa clave es pública por diseño; lo que protege tus datos es `schema.sql`, que impide leer, listar o borrar desde la página.
5. Para ver pedidos: **Table Editor → pedidos**. Los videos y fotos están en **Storage → expedientes → (id del pedido)**.
6. Para crear códigos: **Table Editor → cupones → Insert row** (o el SQL que viene al final de `schema.sql`).

> **Límite de tamaño:** en el plan gratis cada archivo puede pesar hasta 50 MB. La grabación que hace la página pesa unos 10 MB, pero un video de 1 minuto grabado en 4K con la cámara del celular puede pasarse. La página avisa al cliente y le pide uno más ligero. Si necesitas más, sube de plan y cambia `maxUploadMB` en `config.js` y `file_size_limit` en Storage.

> **Aviso de pedidos nuevos (opcional):** en Supabase → Database → Webhooks puedes mandar un aviso a tu correo, Slack, etc. cada vez que entra un registro en `pedidos`.

## Publicar en GitHub Pages

1. Crea un repositorio en GitHub y sube todo el contenido de esta carpeta.
2. **Settings → Pages → Build and deployment → Deploy from a branch →** rama `main`, carpeta `/ (root)`.
3. Para usar `ortostep.com.mx`: en esa misma pantalla escribe el dominio en **Custom domain**, y en tu proveedor de dominio crea los registros DNS que indica GitHub. Activa **Enforce HTTPS** (la cámara del celular solo funciona con HTTPS).

## Antes de publicar: pendientes

- [ ] Sube los 4 videos de ejemplo a `videos/` (ver `videos/LEEME.md`).
- [ ] Completa lo marcado en amarillo en `aviso-privacidad.html` y `terminos.html` (razón social, domicilio, RFC, plazos) y pide a un abogado que los revise.
- [ ] Confirma los tiempos de entrega de la pregunta «¿Cuánto tarda en llegar?» en `index.html`.
- [ ] Si la página anterior estuvo publicada, sus códigos gratis quedaron expuestos: desactívalos en la tabla `cupones` (`activo = false`) y crea nuevos.
- [x] Conecta Supabase.
- [ ] Haz un pedido de prueba completo desde un celular Android y un iPhone.
- [x] Ejecuta `supabase/schema_v2_disenos.sql` en Supabase.
- [ ] Ejecuta `supabase/schema_v3_integracion.sql` en Supabase (conexión con el sistema de plantillas).
- [ ] Despliega el programa de extracción en Easypanel (ver DESPLIEGUE.md).
- [ ] Valida la medición con 10 a 20 pies reales (regla o calibrador) antes de confiar en ella para producción.

## Qué revisa la página en cada captura

En el celular del cliente, sin enviar nada:

- **Videos:** duración mínima (10 s para el escaneo, 6 s para marcha y sentadilla), resolución, luz y tamaño máximo. En los 3 videos de movimiento, MediaPipe Pose revisa que se vea a la persona, sus pies y su cuerpo completo, que no haya otra persona y, en el lateral, que cruce el cuadro.
- **Fotos:** resolución mínima, luz (ni muy oscura ni quemada) y nitidez (detecta fotos movidas o borrosas).
- **Fotos de medida:** detecta la hoja, distingue carta de A4 aunque la foto esté inclinada, corrige la perspectiva y mide en mm el largo (desde la pared), el ancho del antepié, la posición de la 1.ª y la 5.ª cabeza metatarsal y el contorno del pie. Con eso llena el largo y sugiere la talla.
- Si hay un error grave, la captura no se acepta. Si es solo una advertencia, se acepta y se le recomienda repetirla. El ortesista hace la revisión final.

El avance se guarda en el navegador del celular (localStorage + IndexedDB) y se borra al enviar el pedido.
