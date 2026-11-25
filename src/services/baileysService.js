import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import {
  clearConversationHistory,
  generateReply,
} from './geminiService.js';
import { useSupabaseAuthState } from './supabaseAuthState.js';

const AUTH_DIR = 'auth_info';
const INITIAL_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

let activeSocket = null;
let reconnectTimer = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let isShuttingDown = false;
let connectionStatus = 'disconnected';
let authStorageMode = 'local';

/**
 * Logger mínimo compatible con ILogger de Baileys v7:
 * silencia trazas ruidosas, pero muestra errores reales en consola.
 */
const baileysLogger = {
  level: 'error',
  child() {
    return baileysLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error(obj, msg) {
    console.error('[Baileys Error]', msg || '', obj instanceof Error ? obj.message : obj || '');
  },
};

/**
 * Devuelve el estado actual de la conexión de WhatsApp.
 * @returns {'disconnected' | 'connecting' | 'qr' | 'pairing' | 'open' | 'logged_out'}
 */
export function getConnectionStatus() {
  return connectionStatus;
}

/**
 * Devuelve el modo de almacenamiento de sesión activo ('supabase' o 'local').
 * @returns {'supabase' | 'local'}
 */
export function getAuthStorageMode() {
  return authStorageMode;
}

/**
 * Inicializa el estado de autenticación usando Supabase si SUPABASE_URL y SUPABASE_KEY están definidos;
 * de lo contrario usa useMultiFileAuthState('auth_info') como respaldo local.
 */
async function resolveAuthState() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_KEY?.trim();

  if (supabaseUrl && supabaseKey) {
    authStorageMode = 'supabase';
    console.log('[WhatsApp] Usando sesión persistente en Supabase (tabla: whatsapp_auth).');
    return useSupabaseAuthState(supabaseUrl, supabaseKey);
  }

  authStorageMode = 'local';
  console.log(`[WhatsApp] SUPABASE_URL/SUPABASE_KEY no configuradas; usando sesión local en "${AUTH_DIR}".`);
  return useMultiFileAuthState(AUTH_DIR);
}

/**
 * Obtiene la versión real más reciente de WhatsApp Web directamente desde web.whatsapp.com/sw.js.
 * Si falla, usa fetchLatestBaileysVersion() como respaldo.
 * @returns {Promise<[number, number, number]>}
 */
async function resolveLatestWaVersion() {
  const waWeb = await fetchLatestWaWebVersion();
  if (waWeb?.isLatest && Array.isArray(waWeb.version)) {
    return waWeb.version;
  }

  const fallback = await fetchLatestBaileysVersion();
  return fallback.version;
}

/**
 * Extrae el texto plano de un mensaje entrante de Baileys (soporta mensajes efímeros y texto extendido).
 * @param {object} msg
 * @returns {string | null}
 */
function extractMessageText(msg) {
  let content = msg?.message;
  if (!content) return null;

  if (content.ephemeralMessage?.message) {
    content = content.ephemeralMessage.message;
  }
  if (content.viewOnceMessage?.message) {
    content = content.viewOnceMessage.message;
  }
  if (content.viewOnceMessageV2?.message) {
    content = content.viewOnceMessageV2.message;
  }

  const text = content.conversation || content.extendedTextMessage?.text || null;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

/**
 * Determina si un JID debe ignorarse (grupos, estados/difusiones o canales).
 * @param {string} jid
 * @returns {boolean}
 */
function shouldIgnoreJid(jid) {
  return (
    !jid ||
    jid.endsWith('@g.us') ||
    jid === 'status@broadcast' ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter')
  );
}

const COMMAND_PREFIX = '!';
const sentByBotIds = new Set();

/**
 * Registra el ID de un mensaje enviado por el bot para evitar bucles en el chat propio.
 * @param {object} sent
 */
function trackSentMessage(sent) {
  const id = sent?.key?.id;
  if (!id) return;
  sentByBotIds.add(id);
  setTimeout(() => sentByBotIds.delete(id), 60_000).unref?.();
}

/**
 * Envía una respuesta de texto y guarda su ID para ignorarla si vuelve como evento `fromMe`.
 * @param {object} sock
 * @param {string} remoteJid
 * @param {string} text
 */
async function sendBotReply(sock, remoteJid, text) {
  const sent = await sock.sendMessage(remoteJid, { text });
  trackSentMessage(sent);
  return sent;
}

/**
 * Extrae el identificador base de un JID (sin sufijo de dispositivo `:XX` ni dominio `@...`).
 * @param {string} jid
 * @returns {string}
 */
function normalizeJidUser(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0];
}

/**
 * Determina si el JID corresponde al chat contigo mismo ("Tú"), soportando tanto @s.whatsapp.net como @lid.
 * @param {object} sock
 * @param {string} remoteJid
 * @returns {boolean}
 */
function isSelfChat(sock, remoteJid) {
  const remoteUser = normalizeJidUser(remoteJid);
  if (!remoteUser) return false;

  const ownCandidates = [
    normalizeJidUser(sock?.user?.id),
    normalizeJidUser(sock?.user?.lid),
    normalizeJidUser(sock?.authState?.creds?.me?.id),
    normalizeJidUser(sock?.authState?.creds?.me?.lid),
  ].filter(Boolean);

  return ownCandidates.includes(remoteUser);
}

/**
 * Procesa un mensaje de texto entrante y responde en el mismo chat usando Gemini
 * únicamente cuando el mensaje comienza con el prefijo `!`.
 * Permite escribirte a ti mismo en tu propio chat ("Tú") sin responder en chats de terceros donde tú escribes.
 * @param {object} sock
 * @param {object} msg
 */
async function handleIncomingMessage(sock, msg) {
  if (!msg?.key) return;
  if (msg.key.id && sentByBotIds.has(msg.key.id)) return;

  const remoteJid = msg.key.remoteJid;
  if (shouldIgnoreJid(remoteJid)) return;

  if (msg.key.fromMe && !isSelfChat(sock, remoteJid)) return;

  const rawText = extractMessageText(msg);
  if (!rawText || !rawText.startsWith(COMMAND_PREFIX)) return;

  const prompt = rawText.slice(COMMAND_PREFIX.length).trim();
  if (!prompt) return;

  console.log(`[WhatsApp] Mensaje recibido de ${remoteJid}: "${prompt}"`);

  try {
    if (prompt.toLowerCase() === 'reset') {
      clearConversationHistory(remoteJid);
      await sendBotReply(
        sock,
        remoteJid,
        'Memoria de conversación reiniciada. ¿En qué puedo ayudarte ahora?'
      );
      return;
    }

    await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

    const reply = await generateReply(remoteJid, prompt);

    await sendBotReply(sock, remoteJid, reply);

    console.log(`[WhatsApp] Respuesta enviada a ${remoteJid}.`);
  } catch (error) {
    console.error(`[WhatsApp] Error procesando mensaje de ${remoteJid}:`, error);
    await sendBotReply(
      sock,
      remoteJid,
      'Lo siento, tuve un problema temporal al consultar la IA. Intenta de nuevo en unos segundos.'
    ).catch(() => {});
  } finally {
    await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
  }
}

/**
 * Inicia la conexión con WhatsApp usando Baileys, muestra el QR en terminal
 * (o solicita código de emparejamiento de 8 dígitos si se define WHATSAPP_PAIRING_NUMBER)
 * y reconecta automáticamente ante desconexiones inesperadas.
 */
export async function startWhatsApp() {
  isShuttingDown = false;
  connectionStatus = 'connecting';

  const { state, saveCreds } = await resolveAuthState();
  const version = await resolveLatestWaVersion();
  console.log(`[WhatsApp] Usando versión de WhatsApp Web: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true,
    syncFullHistory: false,
  });

  activeSocket = sock;

  // Número opcional para vincular con código de 8 dígitos en vez de QR (solo dígitos con código de país)
  const pairingNumber = (process.env.WHATSAPP_PAIRING_NUMBER || '').replace(/\D/g, '');
  let pairingCodeRequested = false;

  // Guardar actualizaciones de credenciales (en Supabase o en auth_info/ según configuración)
  sock.ev.on('creds.update', saveCreds);

  // Manejar QR, código de emparejamiento, conexión abierta y reconexión automática
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (pairingNumber && !sock.authState.creds.registered) {
        if (!pairingCodeRequested) {
          pairingCodeRequested = true;
          connectionStatus = 'pairing';
          try {
            const code = await sock.requestPairingCode(pairingNumber);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(
              `\n[WhatsApp] Código de vinculación para +${pairingNumber}: ${formatted}\n` +
                'En tu teléfono ve a: WhatsApp → Dispositivos vinculados → Vincular un dispositivo → Vincular con el número de teléfono.\n'
            );
          } catch (err) {
            pairingCodeRequested = false;
            console.error('[WhatsApp] Error solicitando código de vinculación:', err.message);
          }
        }
      } else {
        connectionStatus = 'qr';
        console.log('\n[WhatsApp] Escanea el siguiente código QR con tu teléfono (Dispositivos vinculados):\n');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      console.log('[WhatsApp] Conexión establecida correctamente. El bot está listo para responder.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reasonMsg = lastDisconnect?.error?.message || 'sin detalle';
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isRestartRequired = statusCode === DisconnectReason.restartRequired;

      if (isShuttingDown) {
        connectionStatus = 'disconnected';
        return;
      }

      if (isLoggedOut) {
        connectionStatus = 'logged_out';
        const resetHint =
          authStorageMode === 'supabase'
            ? 'Vacía la tabla "whatsapp_auth" en Supabase'
            : `Elimina la carpeta "${AUTH_DIR}"`;
        console.warn(
          `[WhatsApp] Sesión cerrada manualmente desde el dispositivo. ${resetHint} y reinicia el servidor para volver a vincular.`
        );
        return;
      }

      connectionStatus = 'disconnected';
      clearTimeout(reconnectTimer);

      if (isRestartRequired) {
        console.log('[WhatsApp] Reinicio requerido tras emparejamiento (515). Reconectando...');
        startWhatsApp().catch((err) => {
          console.error('[WhatsApp] Error al reconectar:', err);
        });
        return;
      }

      console.warn(
        `[WhatsApp] Conexión perdida (código: ${statusCode ?? 'desconocido'}, motivo: ${reasonMsg}). ` +
          `Reintentando en ${Math.round(reconnectDelayMs / 1000)}s...`
      );

      reconnectTimer = setTimeout(() => {
        startWhatsApp().catch((err) => {
          console.error('[WhatsApp] Error al reconectar:', err);
        });
      }, reconnectDelayMs);

      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }
  });

  // Escuchar mensajes entrantes en tiempo real
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !Array.isArray(messages)) return;

    await Promise.allSettled(
      messages.map((msg) => handleIncomingMessage(sock, msg))
    );
  });

  return sock;
}

/**
 * Detiene ordenadamente la conexión de Baileys y cancela cualquier reconexión pendiente.
 */
export function stopWhatsApp() {
  isShuttingDown = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  if (activeSocket) {
    try {
      activeSocket.end(undefined);
    } catch {
      // Ignorar errores al cerrar un socket ya cerrado
    }
    activeSocket = null;
  }

  connectionStatus = 'disconnected';
}
