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
 * Desenvuelve wrappers de mensajes efímeros o de visualización única.
 * @param {object} msg
 * @returns {object | null}
 */
function unwrapMessageContent(msg) {
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

  return content;
}

/**
 * Extrae el texto plano de un mensaje entrante de Baileys (soporta mensajes efímeros y texto extendido).
 * @param {object} msg
 * @returns {string | null}
 */
function extractMessageText(msg) {
  const content = unwrapMessageContent(msg);
  if (!content) return null;

  const text = content.conversation || content.extendedTextMessage?.text || null;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

/**
 * Extrae los JIDs mencionados nativamente con @ en WhatsApp.
 * @param {object} msg
 * @returns {string[]}
 */
function extractMentionedJids(msg) {
  const content = unwrapMessageContent(msg);
  const mentioned = content?.extendedTextMessage?.contextInfo?.mentionedJid;
  return Array.isArray(mentioned) ? mentioned : [];
}

/**
 * Determina si un JID debe ignorarse (estados/difusiones o canales).
 * Los chats individuales y grupos sí se permiten cuando se menciona a Tridente o se usa `!`.
 * @param {string} jid
 * @returns {boolean}
 */
function shouldIgnoreJid(jid) {
  return (
    !jid ||
    jid === 'status@broadcast' ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter')
  );
}

const COMMAND_PREFIX = '!';
const BOT_NAME_MENTION_REGEX = /(?:^|[\s,.;:!?¿¡(])@?tridente(?=$|[\s,.;:!?),:])/i;
const LEADING_BOT_NAME_REGEX = /^@?tridente[\s,.:;!?-]*/i;
const MIN_CHAT_INTERVAL_MS = 3000;
const MAX_REPLIES_PER_MINUTE = 15;

const sentByBotIds = new Set();
const recentBotReplies = new Map();
const lastReplyByChat = new Map();
const recentGlobalReplyTimestamps = [];

/**
 * Enmascara un número de teléfono para no exponerlo en los logs (ej. 584127828100 -> ********8100).
 * @param {string} phone
 * @returns {string}
 */
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * Enmascara un JID en logs para proteger números de teléfono en Render/consola.
 * @param {string} jid
 * @returns {string}
 */
function maskJid(jid) {
  if (!jid || typeof jid !== 'string') return 'desconocido';
  const [userPart, domain] = jid.split('@');
  if (!domain) return maskPhone(userPart);
  if (domain === 'g.us') return `grupo:***${userPart.slice(-4)}`;
  return `${maskPhone(userPart)}@${domain}`;
}

/**
 * Registra el ID y contenido reciente de un mensaje enviado por el bot para evitar bucles infinitos.
 * @param {string} remoteJid
 * @param {string} text
 * @param {object} [sent]
 */
function registerBotReplySignature(remoteJid, text) {
  const sig = `${remoteJid}::${String(text || '').trim()}`;
  recentBotReplies.set(sig, Date.now() + 20_000);
  setTimeout(() => recentBotReplies.delete(sig), 20_000).unref?.();
}

function trackSentMessage(sent) {
  const id = sent?.key?.id;
  if (!id) return;
  sentByBotIds.add(id);
  setTimeout(() => sentByBotIds.delete(id), 60_000).unref?.();
}

function isEchoOfBotReply(msg, remoteJid, rawText) {
  if (msg?.key?.id && sentByBotIds.has(msg.key.id)) return true;
  if (!msg?.key?.fromMe) return false;
  const sig = `${remoteJid}::${String(rawText || '').trim()}`;
  const expiresAt = recentBotReplies.get(sig);
  return Boolean(expiresAt && expiresAt > Date.now());
}

/**
 * Envía una respuesta de texto y guarda su huella/ID antes y después para evitar cualquier bucle.
 * @param {object} sock
 * @param {string} remoteJid
 * @param {string} text
 * @param {object} [quotedMsg]
 */
async function sendBotReply(sock, remoteJid, text, quotedMsg = undefined) {
  registerBotReplySignature(remoteJid, text);
  const options = quotedMsg ? { quoted: quotedMsg } : undefined;
  const sent = await sock.sendMessage(remoteJid, { text }, options);
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
 * Devuelve los identificadores propios de la cuenta conectada (teléfono y LID).
 * @param {object} sock
 * @returns {string[]}
 */
function getOwnUsers(sock) {
  return [
    normalizeJidUser(sock?.user?.id),
    normalizeJidUser(sock?.user?.lid),
    normalizeJidUser(sock?.authState?.creds?.me?.id),
    normalizeJidUser(sock?.authState?.creds?.me?.lid),
  ].filter(Boolean);
}

/**
 * Determina si el mensaje menciona nativamente con @ al propio número/LID del bot.
 * @param {object} sock
 * @param {object} msg
 * @returns {boolean}
 */
function isBotMentionedByJid(sock, msg) {
  const ownUsers = getOwnUsers(sock);
  if (ownUsers.length === 0) return false;
  const mentioned = extractMentionedJids(msg);
  return mentioned.some((jid) => ownUsers.includes(normalizeJidUser(jid)));
}

/**
 * Evalúa si un mensaje activa al bot y extrae el prompt limpio para Gemini.
 * Reglas:
 * - Empieza con `!` -> se activa en cualquier chat o grupo.
 * - Menciona `tridente` o `@tridente` -> se activa en cualquier chat o grupo.
 * - Tú (`fromMe`) etiquetas nativamente tu propia cuenta con `@` -> se activa.
 * @param {object} sock
 * @param {object} msg
 * @param {string} rawText
 * @returns {string | null}
 */
function extractTriggeredPrompt(sock, msg, rawText) {
  if (rawText.startsWith(COMMAND_PREFIX)) {
    const prompt = rawText.slice(COMMAND_PREFIX.length).trim();
    return prompt || null;
  }

  if (BOT_NAME_MENTION_REGEX.test(rawText)) {
    const cleaned = rawText.replace(LEADING_BOT_NAME_REGEX, '').trim();
    return cleaned || 'Épale Tridente';
  }

  if (msg.key?.fromMe && isBotMentionedByJid(sock, msg)) {
    const cleaned = rawText.replace(/@\d+/g, '').trim();
    return cleaned || 'Épale Tridente';
  }

  return null;
}

/**
 * Protección anti-spam para cuidar el número de WhatsApp contra ráfagas o bloqueos.
 * @param {string} remoteJid
 * @returns {boolean} true si se permite responder
 */
function checkRateLimit(remoteJid) {
  const now = Date.now();
  const lastChatReply = lastReplyByChat.get(remoteJid) || 0;
  if (now - lastChatReply < MIN_CHAT_INTERVAL_MS) {
    return false;
  }

  // Limpiar timestamps mayores a 1 minuto
  while (recentGlobalReplyTimestamps.length > 0 && now - recentGlobalReplyTimestamps[0] > 60_000) {
    recentGlobalReplyTimestamps.shift();
  }

  if (recentGlobalReplyTimestamps.length >= MAX_REPLIES_PER_MINUTE) {
    console.warn('[WhatsApp] Límite anti-spam alcanzado temporalmente; mensaje omitido para proteger el número.');
    return false;
  }

  lastReplyByChat.set(remoteJid, now);
  recentGlobalReplyTimestamps.push(now);
  return true;
}

/**
 * Procesa un mensaje de texto entrante y responde en el mismo chat o grupo usando Gemini
 * cuando se activa con `!` o mencionando a Tridente (`tridente` / `@tridente`).
 * @param {object} sock
 * @param {object} msg
 */
async function handleIncomingMessage(sock, msg) {
  if (!msg?.key) return;

  const remoteJid = msg.key.remoteJid;
  if (shouldIgnoreJid(remoteJid)) return;

  const rawText = extractMessageText(msg);
  if (!rawText) return;

  if (isEchoOfBotReply(msg, remoteJid, rawText)) return;

  const prompt = extractTriggeredPrompt(sock, msg, rawText);
  if (!prompt) return;

  if (!checkRateLimit(remoteJid)) return;

  const isGroup = remoteJid.endsWith('@g.us');
  const quotedTarget = isGroup ? msg : undefined;

  console.log(`[WhatsApp] Activado en ${maskJid(remoteJid)}: "${prompt.slice(0, 80)}"`);

  try {
    if (prompt.toLowerCase() === 'reset') {
      clearConversationHistory(remoteJid);
      await sendBotReply(
        sock,
        remoteJid,
        'Listo pana, borré la memoria de este chat. Arrancamos de cero.',
        quotedTarget
      );
      return;
    }

    await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

    const reply = await generateReply(remoteJid, prompt);

    await sendBotReply(sock, remoteJid, reply, quotedTarget);

    console.log(`[WhatsApp] Respuesta enviada a ${maskJid(remoteJid)}.`);
  } catch (error) {
    console.error(`[WhatsApp] Error procesando mensaje en ${maskJid(remoteJid)}:`, error);
    await sendBotReply(
      sock,
      remoteJid,
      'Epa, me dio un fallo momentáneo consultando la IA. Intenta de nuevo en unos segundos.',
      quotedTarget
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
              `\n[WhatsApp] Código de vinculación para +${maskPhone(pairingNumber)}: ${formatted}\n` +
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
