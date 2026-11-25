# Chatbot de IA para WhatsApp 

Bot modular en **Node.js + Express** que conecta WhatsApp mediante **`@whiskeysockets/baileys`**, persiste la sesión en **Supabase** (con respaldo automático local en `auth_info/` si no se configura Supabase) y genera respuestas inteligentes con **Google Gemini** (`@google/genai`), con respaldo automático entre modelos y memoria de los últimos 10 mensajes por chat.

---

## Estructura del proyecto

```text
whatsapp-gemini-chatbot/
├── src/
│   ├── index.js                      # Servidor Express (process.env.PORT || 3000) con GET /health
│   └── services/
│       ├── baileysService.js         # Conexión WhatsApp (prefijo `!`, QR o código de 8 dígitos, reconexión)
│       ├── supabaseAuthState.js      # Adaptador de sesión de Baileys sobre Supabase (tabla whatsapp_auth)
│       └── geminiService.js          # Integración @google/genai + respaldo multi-modelo + memoria Map (10 msgs)
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
```

> **Recomendación de seguridad:** en backend/Render utiliza la **`service_role` key** (o configura políticas RLS apropiadas si usas `anon` key). Nunca expongas tu `SUPABASE_KEY` en código frontend ni la subas a Git.

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

- En chats individuales, inicia tu mensaje con **`!`** para activar al asistente (ejemplo: `!hola`, `! explícame qué es una API`).
- Los mensajes sin `!` se ignoran para que el bot no responda automáticamente a tus conversaciones normales.
- Envía **`!reset`** para limpiar la memoria de los últimos 10 mensajes del chat.

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
