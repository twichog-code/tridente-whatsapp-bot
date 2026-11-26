# Chatbot de IA para WhatsApp 

Bot modular en **Node.js + Express** que conecta WhatsApp mediante **`@whiskeysockets/baileys`**, persiste la sesión en **Supabase** (con respaldo automático local en `auth_info/` si no se configura Supabase) y genera respuestas inteligentes con **Google Gemini** (`@google/genai`), con respaldo automático entre modelos y memoria de los últimos 10 mensajes por chat.

---

## Estructura del proyecto

```text
whatsapp-gemini-chatbot/
├── src/
│   ├── index.js                      # Servidor Express (process.env.PORT || 3000) con GET /health
│   └── services/
│       ├── baileysService.js         # Conexión WhatsApp (activación estricta con `!`, fotos, documentos, anti-spam)
│       ├── documentService.js        # Visión de fotos/imágenes y lectura de PDF, Word (.docx), PowerPoint (.pptx) y texto
│       ├── webSearchService.js       # Búsqueda web gratuita en vivo (Google News RSS + Wikipedia ES)
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
   - `WHATSAPP_PAIRING_NUMBER` *(opcional)*: tu número con código de país sin `+` ni espacios para vincular por código de 8 dígitos en vez de QR.
4. Inicia el bot:
   ```bash
   npm start
   ```

---

## 3. Uso del chatbot

- **Activación estricta únicamente con `!`**: el bot responde solo cuando el mensaje (o el texto adjunto a una foto o documento) comienza con **`!`** (ejemplo: `!hola`, `! explica este problema paso a paso`). Mencionar `"tridente"` sin `!` al inicio se ignora.
- **Visión de fotos y lectura de archivos (JPG/PNG/WEBP, PDF, Word `.docx` y PowerPoint `.pptx`)**:
  - Envía la foto o archivo directamente con un comentario que empiece con `!` (ej. `!resuelve este ejercicio`, `!resúmeme este PDF`), **o**
  - Responde (citando) a una foto o archivo ya enviado en el chat escribiendo `!analiza esto`.
- **Información actual en tiempo real (internet en vivo)**: se activa automáticamente cuando preguntas por noticias, tasas, eventos recientes o de 2026 (ej. `!quién es la Miss Venezuela 2026`, `!precio del dólar BCV hoy`), o forzándolo con `!busca ...`.
- **Reiniciar memoria**: envía **`!reset`** para limpiar la memoria de los últimos 20 mensajes del chat.

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
   - *(Opcional)* `GEMINI_MODEL`, `SYSTEM_INSTRUCTION`, `WHATSAPP_PAIRING_NUMBER`
4. Render asigna `PORT` automáticamente y verifica `GET /health` (`200 OK` con estado de WhatsApp y `authStorage: "supabase"`).
5. En el primer arranque, revisa los logs de Render para obtener el código de 8 dígitos (si pusiste `WHATSAPP_PAIRING_NUMBER`) o el QR; la sesión quedará guardada en Supabase y sobrevivirá reinicios y nuevos despliegues.
