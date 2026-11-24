# Programa de extracción ORTOSTEP

Convierte cada pedido que llega a Supabase en una **ficha de diseño de plantilla**:

1. Toma las medidas del pie que la página ya calculó con la foto sobre la hoja: largo, ancho, cabezas metatarsales y contorno, en mm.
2. Descarga los 3 videos de movimiento y calcula las métricas de marcha y sentadilla con MediaPipe: cadencia, tiempo de paso, % de apoyo, asimetría y ángulo FPPA de rodilla.
3. Aplica reglas configurables y genera un **diseño sugerido por pie**: largo de plantilla, altura y posición del arco, copa de talón, poste medial, almohadilla metatarsal, talón suave, espesor y relleno de impresión.
4. Marca **banderas** que obligan a revisión del ortesista: diabetes, dolor intenso, cirugías, medición dudosa, menores, dolor en el dorso, etc.
5. Sube a Supabase `ficha.json` y un `reporte.html` para el ortesista, y registra el estado en la tabla `disenos`.
6. Si se configura `DISENO_CMD`, llama al **sistema de diseño de plantillas** con la ficha y sube los archivos 3D que genere.

Los videos se borran de la computadora al terminar cada pedido, porque son datos de salud.

## Instalación (Windows)

1. Instala **Python 3.12 o más nuevo** desde python.org. Al instalar, marca "Add Python to PATH".
2. En esta carpeta (`worker`), haz doble clic en **`instalar.bat`**. Crea el entorno e instala MediaPipe, OpenCV y NumPy.
3. Copia `config.ejemplo.env` como **`.env`** y llena:
   - `SUPABASE_URL`: la de tu proyecto.
   - `SUPABASE_SECRET_KEY`: la clave **secreta** (`sb_secret_…`), de Supabase → Project Settings → API Keys.
     ⚠️ Esta clave da acceso total. Va solo en este archivo, en esta computadora. Nunca la pegues en la página web, en un chat ni en GitHub (el `.gitignore` ya excluye `.env`).
4. En Supabase → SQL Editor, ejecuta **`supabase/schema_v2_disenos.sql`**. Crea la tabla `disenos` y el bucket `disenos`.
5. Doble clic en **`iniciar.bat`**: queda vigilando pedidos nuevos cada minuto.

## Comandos

```
.venv\Scripts\python -m ortostep_worker vigilar           # modo continuo
.venv\Scripts\python -m ortostep_worker procesar OS-...    # un pedido por folio
.venv\Scripts\python -m ortostep_worker local CARPETA      # sin Supabase: CARPETA con pedido.json y videos (marcha.mp4, marcha-lateral.mp4, sentadilla.mp4)
.venv\Scripts\python tests\test_basico.py                  # pruebas
```

## Estados del pedido

| Estado | Significa |
|---|---|
| `nuevo` | Recién llegado de la página |
| `ficha_lista` | Ficha generada, sin banderas, esperando el diseño 3D |
| `disenado` | El sistema de diseño generó los archivos 3D |
| `requiere_revision` | Tiene banderas: el ortesista debe revisarlo antes de diseñar |
| `error_ficha` | Algo falló; ver la consola |

## Ajustar las reglas

Copia `ortostep_worker/reglas_default.json` como **`reglas.json`** en esta carpeta y cambia solo lo que quieras: alturas de arco, copa de talón, posteos, posición de la almohadilla, relleno por peso, bloqueos. Casi todos los valores son **puntos de partida de opinión experta**, no umbrales clínicos validados; el ortesista debe calibrarlos.

## Flujo hasta el STL (acordado el 2026-11-24)

1. **Este programa** genera la ficha y deja `disenos.estado = 'ficha_lista'`. Si la ficha tiene banderas, queda en `'requiere_revision'`: el ortesista la revisa en el reporte y, si procede, la cambia a mano a `'ficha_lista'` en el Table Editor.
2. **El sistema de plantillas**, que corre en el mismo Easypanel, revisa Supabase con `tomar_para_diseno()`. La ficha pasa a `'en_cola_diseno'`. Lee `para_diseno.json` y `medidas.json` y crea el caso en la cola de las diseñadoras con:
   - horma = `producto.horma_para_diseno` (Sandalia y Bostoniana se diseñan como **CLASICA**);
   - densidad = `sugerencias_ortostep.densidad_sugerida.valor`;
   - sucursal = `ORTOSTEP`.
   Lo autodeclarado es **solo informativo**: se muestra a la diseñadora y nunca entra a «notas».
3. La diseñadora valida y el sistema sube los 2 STL a `disenos/{id_pedido}/v1/stl/`. Después llama a `registrar_stl()`: el diseño pasa a `'stl_validado'` y el pedido a `'stl_listo'`. Si se rechaza, llama a `marcar_diseno_rechazado()`.

Las funciones están en `supabase/schema_v3_integracion.sql`. **Hay que ejecutarlo** en Supabase. Solo funcionan con la clave secreta, que va en las variables del sistema de plantillas en Easypanel.

## Conectar el sistema de diseño de plantillas

Por cada pedido se generan dos archivos en el formato acordado con el proyecto de diseño (`automatizacion de plantillas`):

- **`para_diseno.json`**: contiene el pedido, el cliente, el producto (CLASICA/DEPORTIVA), los pies medidos (largo, ancho, cabezas metatarsales y contorno con origen en el talón), los datos autodeclarados **en un bloque aparte** (nunca en «notas», porque ese sistema convierte las notas en aditamentos), la marcha, las banderas y las sugerencias de ORTOSTEP.
- **`medidas.json`**: `{"left": {"footLength", "footWidth"}, "right": {...}}`, el formato que ese sistema ya lee como medidas opcionales.

Se suben a Supabase Storage en `disenos/{id_pedido}/v1/`. El sistema de diseño **todavía no tiene importador** para ORTOSTEP. Hay dos vías posibles, y la decisión es tuya:

1. El sistema de diseño lee de Supabase con una clave de solo lectura.
2. Este programa le envía cada pedido a una ruta nueva con token.

`DISENO_CMD` (en `.env`) existe para cuando haya un **importador aprobado** que cree el caso en la cola de revisión de las diseñadoras. El programa sustituye `{para_diseno}`, `{ficha}` y `{salida}`, y solo lo llama cuando la ficha no tiene banderas.

> ⚠️ **No conectes `DISENO_CMD` directamente al motor de diseño.** En ese sistema, todo diseño pasa por la validación de una diseñadora antes de imprimirse. Un comando que genere los STL directo se saltaría esa revisión.
>
> Tampoco pruebes contra su servidor real: cada llamada crea un caso de verdad en la cola de las diseñadoras.

### Detalles del formato que conviene saber

- **Largo de la plantilla:** sale de la **talla** (talla 25 → 253 mm), no del largo del pie. En pedidos reales, la talla × 10 queda entre 5 y 22 mm por encima del pie (mediana 13). Si no cae en ese rango, la ficha pone la bandera `talla_corta_*` o `talla_larga_*` y pide revisión.
- **`mtf1_pct` y `mtf5_pct`:** son **fracción** del largo del pie desde el talón, de 0 a 1 (0.71 = 71 %), no de 0 a 100. El JSON lo declara en `unidades`.
- **`cliente.nombre`:** trae nombre y apellido; la página lo exige. De ahí salen las iniciales grabadas y el nombre de los archivos.
- **`sugerencias_ortostep.por_pie`:** usa grados de poste y almohadilla metatarsal, mientras que el sistema de diseño trabaja con cuñas en mm y barras. No hay traducción uno a uno y es criterio clínico, así que el importador las ignora hasta que decidas. Solo `densidad_sugerida` usa su mismo vocabulario.

## Formato de la ficha (resumen)

- `pies.derecho|izquierdo`: `largo_mm`, `ancho_mm`, `ancho_talon_mm` (estimado), `mtp1_pct`, `mtp5_pct` (posición de la 1.ª y 5.ª cabeza metatarsal como fracción del largo, desde el talón), `contorno_mm` (puntos `[x, y]` en mm; `y` desde el talón, `x` positivo hacia el lado interno), `fuente`, `confianza`.
- `marcha`: métricas por video (`marcha-lateral`, `marcha`, `sentadilla`) con su calidad y notas.
- `banderas`: lista `{codigo, mensaje, bloquea}`. `requiere_revision` es verdadero si alguna bloquea.
- `diseno_sugerido.por_pie`: parámetros de diseño por pie; `diseno_sugerido.impresion`: material y relleno.

Ejemplo completo: `tests/salida_ejemplo/ficha.json` y `tests/salida_ejemplo/reporte.html`.

## Limitaciones honestas

- Las medidas son 2D (foto desde arriba). El talón queda tapado por la pierna y su ancho es estimado. **La planta del pie no se mide**: el arco se diseña con reglas, no con un escaneo.
- Las métricas de marcha son de **tamizaje**. Cadencia, tiempo de paso y % de apoyo (de lado) son lo más confiable; el FPPA de la sentadilla detecta desalineación, pero no equivale al valgo real en 3D.
- Está probado con datos sintéticos y con detección de pose en imágenes reales. **Falta validarlo con videos y pies reales** de clientes, comparando contra regla, calibrador y la valoración del ortesista.
