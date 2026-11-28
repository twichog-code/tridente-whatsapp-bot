import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import {
  MAX_DOCUMENT_BYTES,
  MAX_VIDEO_BYTES,
  UnsupportedDocumentError,
  prepareDocumentForGemini,
} from './documentService.js';
import {
  clearConversationHistory,
  generateReply,
} from './geminiService.js';
import {
  createStickerFromImage,
  createStickerFromText,
} from './stickerService.js';
import { useSupabaseAuthState } from './supabaseAuthState.js';

const AUTH_DIR = 'auth_info';
const INITIAL_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const COMMAND_PREFIX = '!';
const STICKER_CMD_REGEX = /^(sticker|s)(?:\s+([\s\S]+))?$/i;
const MIN_USER_INTERVAL_MS = 3000;
const MAX_REPLIES_PER_MINUTE = 15;

let activeSocket = null;
let reconnectTimer = null;
let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let isShuttingDown = false;
let connectionStatus = 'disconnected';
let authStorageMode = 'local';

const sentByBotIds = new Set();
const recentBotReplies = new Map();
const lastReplyBySender = new Map();
const recentGlobalReplyTimestamps = [];
// Caché pasivo de nombres visibles de participantes en grupos: Map<participantUser, pushName>
const participantNames = new Map();

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
  console.log(
    `[WhatsApp] SUPABASE_URL/SUPABASE_KEY no configuradas; usando sesión local en "${AUTH_DIR}".`
  );
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
 * Desenvuelve wrappers de mensajes efímeros, visualización única o documentos con caption.
 * @param {object} rawContent
 * @returns {object | null}
 */
function unwrapMessageContent(rawContent) {
  let content = rawContent;
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
  if (content.documentWithCaptionMessage?.message) {
    content = content.documentWithCaptionMessage.message;
  }

  return content;
}

/**
 * Extrae el texto plano (o caption de foto/video/documento) de un mensaje de Baileys.
 * @param {object} msg
 * @returns {string | null}
 */
export function extractMessageText(msg) {
  const content = unwrapMessageContent(msg?.message);
  if (!content) return null;

  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    null;

  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

/**
 * Extrae metadatos unificados de un documento, foto o video dentro de un mensaje desenvuelto.
 * @param {object} unwrappedContent
 * @returns {{ mediaKind: 'document' | 'image' | 'video', mimetype: string, fileName: string, fileLength: number } | null}
 */
function pickMediaMetadata(unwrappedContent) {
  if (unwrappedContent?.documentMessage) {
    const doc = unwrappedContent.documentMessage;
    return {
      mediaKind: 'document',
      mimetype: doc.mimetype || '',
      fileName: doc.fileName || 'documento',
      fileLength: Number(doc.fileLength || 0),
    };
  }
  if (unwrappedContent?.imageMessage) {
    const img = unwrappedContent.imageMessage;
    return {
      mediaKind: 'image',
      mimetype: img.mimetype || 'image/jpeg',
      fileName: 'foto.jpg',
      fileLength: Number(img.fileLength || 0),
    };
  }
  if (unwrappedContent?.videoMessage) {
    const vid = unwrappedContent.videoMessage;
    return {
      mediaKind: 'video',
      mimetype: vid.mimetype || 'video/mp4',
      fileName: 'video.mp4',
      fileLength: Number(vid.fileLength || 0),
    };
  }
  return null;
}

/**
 * Busca si el mensaje actual adjunta una foto/video/documento o responde/cita uno previo.
 * @param {object} msg
 * @returns {{ targetMsg: object, docMsg: { mediaKind: string, mimetype: string, fileName: string, fileLength: number } } | null}
 */
export function extractDocumentSource(msg) {
  const content = unwrapMessageContent(msg?.message);
  if (!content) return null;

  // Caso 1: foto, video o documento enviado directamente (con caption iniciando en `!`)
  const directMeta = pickMediaMetadata(content);
  if (directMeta) {
    return {
      targetMsg: msg,
      docMsg: directMeta,
    };
  }

  // Caso 2: respuesta/cita a un mensaje previo que contenía foto, video o documento
  const contextInfo = content.extendedTextMessage?.contextInfo;
  if (contextInfo?.quotedMessage) {
    const quotedContent = unwrapMessageContent(contextInfo.quotedMessage);
    const quotedMeta = pickMediaMetadata(quotedContent);
    if (quotedMeta) {
      return {
        targetMsg: {
          key: {
            remoteJid: msg.key?.remoteJid,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant,
          },
          message: contextInfo.quotedMessage,
        },
        docMsg: quotedMeta,
      };
    }
  }

  return null;
}

/**
 * Extrae el identificador base de un JID (sin sufijo `:XX` ni dominio `@...`).
 * @param {string} jid
 * @returns {string}
 */
function normalizeJidUser(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0];
}

/**
 * Registra pasivamente el nombre visible (`pushName`) de cada participante en grupos
 * para reconocer siempre a varias personas incluso al responder/citar mensajes anteriores.
 * @param {object} msg
 */
function rememberGroupParticipant(msg) {
  const participantJid = msg?.key?.participant || msg?.key?.participantAlt;
  const userId = normalizeJidUser(participantJid);
  const name = msg?.pushName?.trim();
  if (userId && name) {
    participantNames.set(userId, name);
  }
}

/**
 * Resuelve el ID y nombre legible de quien habla (clave para distinguir múltiples personas en grupos).
 * @param {object} sock
 * @param {object} msg
 * @param {boolean} isGroup
 * @returns {{ senderId: string, senderName: string }}
 */
export function resolveSenderInfo(sock, msg, isGroup) {
  if (msg?.key?.fromMe) {
    const ownId =
      normalizeJidUser(sock?.user?.id) ||
      normalizeJidUser(sock?.authState?.creds?.me?.id) ||
      'owner';
    const ownName =
      msg?.pushName?.trim() ||
      sock?.user?.name?.trim() ||
      sock?.authState?.creds?.me?.name?.trim() ||
      'Tú (Dueño)';
    return { senderId: ownId, senderName: ownName };
  }

  const rawSenderJid = isGroup
    ? msg?.key?.participant || msg?.key?.participantAlt || msg?.key?.remoteJid
    : msg?.key?.remoteJid;

  const senderId = normalizeJidUser(rawSenderJid) || 'desconocido';
  const pushName = msg?.pushName?.trim();

  if (pushName) {
    participantNames.set(senderId, pushName);
    return { senderId, senderName: pushName };
  }

  const cachedName = participantNames.get(senderId);
  if (cachedName) {
    return { senderId, senderName: cachedName };
  }

  return {
    senderId,
    senderName: `Participante ${senderId.slice(-4) || 'anónimo'}`,
  };
}

/**
 * Si el mensaje cita un mensaje de texto previo en un grupo, extrae quién lo dijo y qué decía.
 * @param {object} msg
 * @returns {string}
 */
export function extractQuotedTextContext(msg) {
  const content = unwrapMessageContent(msg?.message);
  const contextInfo = content?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.quotedMessage) return '';

  const quotedText = extractMessageText({ message: contextInfo.quotedMessage });
  if (!quotedText) return '';

  const quotedUserId = normalizeJidUser(contextInfo.participant);
  const quotedAuthor =
    (quotedUserId && participantNames.get(quotedUserId)) ||
    (quotedUserId ? `Participante ${quotedUserId.slice(-4)}` : 'otro mensaje');

  return `[Citando a ${quotedAuthor}: "${quotedText.slice(0, 300)}"]`;
}

/**
 * Determina si un JID debe ignorarse (estados/difusiones o canales).
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

/**
 * Activa el bot ESTRICTA Y ÚNICAMENTE cuando el mensaje comienza con `!`.
 * Decir "tridente" o "@tridente" sin `!` al inicio NO activa el bot.
 * @param {string} rawText
 * @returns {string | null}
 */
export function extractTriggeredPrompt(rawText) {
  if (typeof rawText !== 'string') return null;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;

  const prompt = trimmed.slice(COMMAND_PREFIX.length).trim();
  return prompt || null;
}

/**
 * Analiza si un prompt es un comando de sticker (`!sticker`, `!s`, `!sticker <texto>`).
 * @param {string} prompt
 * @returns {{ isSticker: boolean, text: string }}
 */
export function parseStickerCommand(prompt) {
  const match = String(prompt || '').trim().match(STICKER_CMD_REGEX);
  if (!match) return { isSticker: false, text: '' };
  return {
    isSticker: true,
    text: (match[2] || '').trim(),
  };
}

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
 */
async function sendBotReply(sock, remoteJid, text, quotedMsg = undefined) {
  registerBotReplySignature(remoteJid, text);
  const options = quotedMsg ? { quoted: quotedMsg } : undefined;
  const sent = await sock.sendMessage(remoteJid, { text }, options);
  trackSentMessage(sent);
  return sent;
}

/**
 * Envía un sticker WebP y registra su ID para evitar bucles.
 */
async function sendBotSticker(sock, remoteJid, webpBuffer, quotedMsg = undefined) {
  const options = quotedMsg ? { quoted: quotedMsg } : undefined;
  const sent = await sock.sendMessage(remoteJid, { sticker: webpBuffer }, options);
  trackSentMessage(sent);
  return sent;
}

/**
 * Protección anti-spam por usuario dentro de cada chat + límite global por minuto.
 * Permite que varias personas en un grupo hablen al mismo tiempo sin bloquearse entre sí.
 * @param {string} remoteJid
 * @param {string} senderId
 * @returns {boolean}
 */
function checkRateLimit(remoteJid, senderId) {
  const now = Date.now();
  const senderKey = `${remoteJid}::${senderId}`;
  const lastReply = lastReplyBySender.get(senderKey) || 0;
  if (now - lastReply < MIN_USER_INTERVAL_MS) {
    return false;
  }

  while (
    recentGlobalReplyTimestamps.length > 0 &&
    now - recentGlobalReplyTimestamps[0] > 60_000
  ) {
    recentGlobalReplyTimestamps.shift();
  }

  if (recentGlobalReplyTimestamps.length >= MAX_REPLIES_PER_MINUTE) {
    console.warn(
      '[WhatsApp] Límite anti-spam alcanzado temporalmente; mensaje omitido para proteger el número.'
    );
    return false;
  }

  lastReplyBySender.set(senderKey, now);
  recentGlobalReplyTimestamps.push(now);
  return true;
}

/**
 * Procesa el comando `!sticker` / `!s` (a partir de una foto directa/citada o de texto).
 */
async function handleStickerCommand(sock, { remoteJid, stickerText, docSource, quotedTarget }) {
  // Caso 1: Foto adjunta o citada -> convertir a sticker WebP 512x512
  if (docSource) {
    if (docSource.docMsg.mediaKind !== 'image') {
      await sendBotReply(
        sock,
        remoteJid,
        'Pana, para crear stickers envíame o cita una *foto* con `!sticker` (o escribe `!sticker tu texto` para hacer uno de texto).',
        quotedTarget
      );
      return;
    }

    if (docSource.docMsg.fileLength > MAX_DOCUMENT_BYTES) {
      await sendBotReply(
        sock,
        remoteJid,
        'Esa imagen es muy pesada para convertirla a sticker. Mándame una más liviana.',
        quotedTarget
      );
      return;
    }

    const buffer = await downloadMediaMessage(
      docSource.targetMsg,
      'buffer',
      {},
      {
        logger: baileysLogger,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    const webpBuffer = await createStickerFromImage(buffer);
    await sendBotSticker(sock, remoteJid, webpBuffer, quotedTarget);
    console.log(`[WhatsApp] Sticker de imagen enviado a ${maskJid(remoteJid)}.`);
    return;
  }

  // Caso 2: Texto -> generar sticker tipográfico 512x512
  if (stickerText) {
    const webpBuffer = await createStickerFromText(stickerText);
    await sendBotSticker(sock, remoteJid, webpBuffer, quotedTarget);
    console.log(`[WhatsApp] Sticker de texto enviado a ${maskJid(remoteJid)}.`);
    return;
  }

  // Sin foto ni texto -> mostrar ayuda breve
  await sendBotReply(
    sock,
    remoteJid,
    'Para mandar un sticker:\n• Envía o responde a una *foto* con `!sticker` (o `!s`)\n• O escribe `!sticker tu frase` para hacerlo de texto.',
    quotedTarget
  );
}

/**
 * Procesa mensajes entrantes y responde ÚNICAMENTE cuando el texto (o caption del archivo)
 * empieza con `!`. Soporta multi-persona en grupos, stickers, videos, fotos y PDF/Word/PPTX.
 * @param {object} sock
 * @param {object} msg
 */
async function handleIncomingMessage(sock, msg) {
  if (!msg?.key) return;

  const remoteJid = msg.key.remoteJid;
  if (shouldIgnoreJid(remoteJid)) return;

  const isGroup = remoteJid.endsWith('@g.us');
  if (isGroup) {
    rememberGroupParticipant(msg);
  }

  const rawText = extractMessageText(msg);
  if (!rawText) return;

  if (isEchoOfBotReply(msg, remoteJid, rawText)) return;

  const prompt = extractTriggeredPrompt(rawText);
  if (!prompt) return;

  const { senderId, senderName } = resolveSenderInfo(sock, msg, isGroup);
  if (!checkRateLimit(remoteJid, senderId)) return;

  const quotedTarget = isGroup ? msg : undefined;
  const docSource = extractDocumentSource(msg);
  const stickerCmd = parseStickerCommand(prompt);

  console.log(
    `[WhatsApp] Comando ! en ${maskJid(remoteJid)}` +
      `${isGroup ? ` [${senderName}]` : ''}` +
      `${docSource ? ` [${docSource.docMsg.mediaKind}]` : ''}` +
      `: "${prompt.slice(0, 80)}"`
  );

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

    if (stickerCmd.isSticker) {
      await handleStickerCommand(sock, {
        remoteJid,
        stickerText: stickerCmd.text,
        docSource,
        quotedTarget,
      });
      return;
    }

    await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});

    let preparedDocument = undefined;
    if (docSource) {
      const { fileName, mimetype, fileLength, mediaKind } = docSource.docMsg;
      const maxBytes = mediaKind === 'video' ? MAX_VIDEO_BYTES : MAX_DOCUMENT_BYTES;

      if (fileLength > maxBytes) {
        const maxMb = Math.round(maxBytes / (1024 * 1024));
        await sendBotReply(
          sock,
          remoteJid,
          `Pana, ese archivo "${fileName}" pasa de ${maxMb} MB. Mándamelo un poco más liviano o corto para poder leerlo.`,
          quotedTarget
        );
        return;
      }

      const buffer = await downloadMediaMessage(
        docSource.targetMsg,
        'buffer',
        {},
        {
          logger: baileysLogger,
          reuploadRequest: sock.updateMediaMessage,
        }
      );

      preparedDocument = await prepareDocumentForGemini(buffer, {
        mimeType: mimetype,
        fileName,
      });
    }

    const quotedContext = isGroup && !docSource ? extractQuotedTextContext(msg) : '';

    const reply = await generateReply(remoteJid, prompt, {
      document: preparedDocument,
      isGroup,
      senderName,
      quotedContext,
    });

    await sendBotReply(sock, remoteJid, reply, quotedTarget);

    console.log(`[WhatsApp] Respuesta enviada a ${maskJid(remoteJid)}.`);
  } catch (error) {
    if (error instanceof UnsupportedDocumentError) {
      await sendBotReply(sock, remoteJid, error.message, quotedTarget).catch(() => {});
      return;
    }

    console.error(`[WhatsApp] Error procesando mensaje en ${maskJid(remoteJid)}:`, error);
    await sendBotReply(
      sock,
      remoteJid,
      'Epa, me dio un fallo momentáneo procesando eso. Intenta de nuevo en unos segundos.',
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

  const pairingNumber = (process.env.WHATSAPP_PAIRING_NUMBER || '').replace(/\D/g, '');
  let pairingCodeRequested = false;

  sock.ev.on('creds.update', saveCreds);

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
        console.log(
          '\n[WhatsApp] Escanea el siguiente código QR con tu teléfono (Dispositivos vinculados):\n'
        );
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      console.log(
        '[WhatsApp] Conexión establecida correctamente. El bot está listo para responder (solo con prefijo !).'
      );
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !Array.isArray(messages)) return;

    await Promise.allSettled(messages.map((msg) => handleIncomingMessage(sock, msg)));
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
