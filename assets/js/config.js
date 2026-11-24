/* ==========================================================
   ORTOSTEP — configuración
   Edita SOLO este archivo para conectar la página.
   ========================================================== */
window.ORTOSTEP_CONFIG = {
  /* Supabase (recibe pedidos, videos y fotos, y valida códigos).
     Déjalos vacíos y la página funciona en "modo WhatsApp": el cliente
     te manda su resumen y sus archivos por WhatsApp.
     Dónde encontrarlos: Supabase → Project Settings → API.
     La clave "anon" / "publishable" es pública por diseño: es seguro ponerla aquí
     siempre que ejecutes supabase/schema.sql (que bloquea lecturas). */
  supabaseUrl: 'https://plqrtljatdmisluwurmc.supabase.co',
  supabaseAnonKey: 'sb_publishable_puQkW2T2j7_mdeqpDxjNSA_iNu4nvAu',
  bucket: 'expedientes',

  /* Tamaño máximo por archivo, en MB. En el plan gratis de Supabase el máximo es 50. */
  maxUploadMB: 50,

  /* WhatsApp del negocio: 52 + 10 dígitos, sin espacios ni signos. */
  whatsapp: '525568182010',

  email: 'hola@ortostep.com.mx'
};
