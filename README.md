# Chatbot de IA para WhatsApp 

Bot modular en **Node.js + Express** que conecta WhatsApp mediante **`@whiskeysockets/baileys`**, persiste la sesión en **Supabase** (con respaldo automático local en `auth_info/` si no se configura Supabase) y genera respuestas inteligentes con **Google Gemini** (`@google/genai`), con respaldo automático entre modelos y memoria de los últimos 10 mensajes por chat.

---

## Estructura del proyecto

```text
whatsapp-gemini-chatbot/
├── src/
│   ├── index.js                      # Servidor Express (process.env.PORT || 3000) con GET /health
│   └── services/
│       ├── baileysService.js         # Conexión WhatsApp (! estricto, grupos multi-persona, fotos/videos/docs, stickers)
│       ├── documentService.js        # Visión de fotos/videos y lectura de PDF, Word (.docx), PowerPoint (.pptx) y texto
│       ├── stickerService.js         # Generador de stickers WebP 512x512 desde fotos o texto (sharp)
│       ├── webSearchService.js       # Búsqueda web en vivo (Tavily global + DolarAPI BCV + respaldo Google News/Wikipedia)
│       ├── supabaseAuthState.js      # Adaptador de sesión de Baileys sobre Supabase (tabla whatsapp_auth)
│       └── geminiService.js          # Integración @google/genai + razonamiento fuerte + respaldo multi-modelo
├── .env.example                      # Plantilla de variables de entorno
├── .gitignore
├── package.json
└── README.md
```

---

## 1. Crear la tabla en Supabase (para Render / producción)

En tu proyecto de **Supabase → SQL Editor**, ejecuta:

```sql
CREATE TABLE IF NOT EXISTS whatsapp_auth (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL
);

ALTER TABLE whatsapp_auth ENABLE ROW LEVEL SECURITY;
```

> **Recomendación de seguridad:** en backend/Render utiliza la **`service_role` key** (con RLS activado, solo tu backend tiene acceso y se bloquea cualquier acceso público con `anon` key). Nunca expongas tu `SUPABASE_KEY` en código frontend ni la subas a Git.

---

## 2. Instalación y configuración local

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Crea `.env` a partir de `.env.example`:
   ```bash
   Copy-Item .env.example .env   # PowerShell
   # cp .env.example .env        # Linux / macOS
   ```
3. Configura las variables:
   - `PORT`: puerto del servidor Express (por defecto `3000`).
   - `GEMINI_API_KEY`: clave de Google AI Studio.
   - `SUPABASE_URL` y `SUPABASE_KEY` *(opcionales en local)*: si se definen, la sesión se guarda en la tabla `whatsapp_auth` de Supabase; si se omiten, se guarda localmente en `auth_info/`.
   - `TAVILY_API_KEY` *(opcional)*: clave gratuita de [Tavily](https://app.tavily.com) (1.000 búsquedas/mes gratis) para búsqueda web completa global; si se omite, usa Google News RSS + Wikipedia ES automáticamente.
   - `WHATSAPP_PAIRING_NUMBER` *(opcional)*: tu número con código de país sin `+` ni espacios para vincular por código de 8 dígitos en vez de QR.
4. Inicia el bot:
   ```bash
   npm start
   ```

---

## 3. Uso del chatbot

- **Activación estricta únicamente con `!`**: el bot responde solo cuando el mensaje (o el texto adjunto a una foto, video o documento) comienza con **`!`** (ejemplo: `!hola`, `! explica este problema paso a paso`). Mencionar `"tridente"` sin `!` al inicio se ignora.
- **Grupos con múltiples personas**: reconoce a cada participante por su nombre, mantiene contexto de citas entre usuarios y permite que varios hablen sin bloquearse entre sí.
- **Stickers (`!sticker` o `!s`)**:
  - Envía o cita una **foto** con `!sticker` (o `!s`) para convertirla en sticker WebP 512×512.
  - Escribe `!sticker tu frase` (o `!s Fino`) para crear un sticker de texto al instante.
- **Visión de fotos, videos y lectura de archivos (JPG/PNG/WEBP, MP4/MOV/WEBM, PDF, Word `.docx` y PowerPoint `.pptx`)**:
  - Envía la foto, video (hasta 18 MB) o archivo directamente con un comentario que empiece con `!` (ej. `!qué pasa en este video?`, `!resúmeme este PDF`), **o**
  - Responde (citando) a una foto, video o archivo ya enviado en el chat escribiendo `!analiza esto`.
- **Información actual en tiempo real (internet en vivo)**:
  - **Divisas en Venezuela**: tasas exactas de Dólar/Euro BCV y Paralelo directo vía DolarAPI.
  - **Cualquier tema del mundo**: si agregas `TAVILY_API_KEY` lee páginas web completas de todo el mundo; si no, usa Google News RSS + Wikipedia ES automáticamente (también puedes forzar búsqueda con `!busca ...`).
- **Reiniciar memoria**: envía **`!reset`** para limpiar la memoria de los últimos 24 mensajes del chat.

---

## 4. Despliegue en Render

1. Sube el repositorio a GitHub (sin `.env` ni `auth_info/`).
2. En [Render](https://render.com) crea un **Web Service**:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
3. Agrega en **Environment Variables**:
   - `GEMINI_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - *(Opcional recomendado)* `TAVILY_API_KEY`
   - *(Opcional)* `WHATSAPP_PAIRING_NUMBER` (puedes quitarla tras vincular)
4. Render asigna `PORT` automáticamente y verifica `GET /health` (`200 OK` con estado de WhatsApp, `authStorage` y `webSearch`).
5. En el primer arranque, revisa los logs de Render para obtener el código de 8 dígitos (si pusiste `WHATSAPP_PAIRING_NUMBER`) o el QR; la sesión quedará guardada en Supabase y sobrevivirá reinicios y nuevos despliegues.
