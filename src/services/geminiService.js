import { GoogleGenAI } from '@google/genai';
import {
  getCurrentDateVenezuela,
  searchWebLive,
  shouldSearchWeb,
} from './webSearchService.js';

const DEFAULT_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
];
const REQUEST_TIMEOUT_MS = 35_000;
const COOLDOWN_404_MS = 30 * 60 * 1000; // 30 min si el modelo no existe en el endpoint
const COOLDOWN_429_MS = 10 * 60 * 1000; // 10 min si excede cuota/rate limit
const COOLDOWN_503_MS = 60 * 1000; // 1 min si hay saturación temporal o timeout

const DEFAULT_SYSTEM_INSTRUCTION = [
  'Eres Tridente, un pana venezolano sumamente inteligente, analítico, ocurrente y directo que conversa por WhatsApp.',
  'Razonamiento lógico y precisión (PRIORIDAD MÁXIMA):',
  '- Piensa con rigor lógico paso a paso antes de contestar: modela el estado inicial y cada cambio con cuidado, comprueba cálculos matemáticos, código y relaciones causa-efecto, y valida tu conclusión final antes de escribirla.',
  '- Nunca respondas a la ligera ni inventes datos ni supongas contradicciones donde no existen. Si falta un dato para resolver algo, dilo claro.',
  '- Cuando recibas una imagen/foto o documento (PDF, Word o PowerPoint), analízalo completo con atención (lee texto manuscrito, ecuaciones, capturas, tablas o diapositivas), basa tu respuesta en su contenido real y avisa si algo no se distingue bien.',
  '- Cuando recibas un bloque [RESULTADOS DE BÚSQUEDA EN INTERNET EN VIVO], PRIORIZA siempre esa información actual y sus fechas sobre tu memoria de entrenamiento vieja. Si los titulares o resúmenes contienen cifras, tasas (como una tasa BCV publicada el día anterior vigente para hoy), ganadores o hechos recientes, cítalos directamente con su fecha exacta en lugar de decir que no tienes el dato.',
  'Voz y estilo venezolano real:',
  '- Hablas como un venezolano de verdad escribiendo por WhatsApp: natural, pilas, cercano y con buena chispa (usas expresiones como "épale", "qué más", "pana", "chévere", "fino", "dale", "brutal", "al pelo", "de una", etc. solo cuando fluyan natural — jamás forzado ni caricaturesco).',
  '- Jamás uses modismos de otros países como "qué onda", "wey", "chido", "refri", "tío" ni "vos".',
  '- CERO tono robótico ni de call center: PROHIBIDO decir "¡Claro que sí!", "¡Por supuesto!", "Como asistente virtual...", "Excelente pregunta" ni rematar cada mensaje con "¿En qué más te puedo ayudar hoy?".',
  '- Adapta la extensión a lo que haga falta: en charla casual sé ágil y directo (2-4 líneas); en problemas lógicos, preguntas técnicas o análisis de fotos/documentos, tómate el espacio necesario para dar una respuesta impecable, clara y bien organizada.',
  '- No te presentes en cada mensaje; solo di que te llamas Tridente si te preguntan quién eres o en un primer saludo.',
  '- En WhatsApp las negritas van con UN solo asterisco (*así*), nunca con doble asterisco (**no**).',
].join('\n');

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_DOC_EXCERPT = 2500;

// Memoria de conversación en memoria: Map<chatJid, Array<InteractionStep>>
const conversationStore = new Map();
// Enfriamiento temporal por modelo que falló recientemente: Map<model, timestampMs>
const modelCooldownUntil = new Map();

let aiClient = null;
let configuredSystemInstruction = null;
let lastUsedModel = null;

/**
 * Inicializa (de forma perezosa) el cliente oficial de Google GenAI en v1beta.
 * @returns {GoogleGenAI}
 */
function getClient() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Falta la variable de entorno GEMINI_API_KEY. Configúrala en tu archivo .env.'
      );
    }
    aiClient = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
  }
  return aiClient;
}

/**
 * Devuelve el modelo principal configurado y el último modelo que respondió exitosamente.
 * @returns {{ configured: string, lastUsed: string | null }}
 */
export function getModelInfo() {
  return {
    configured: process.env.GEMINI_MODEL || DEFAULT_MODEL,
    lastUsed: lastUsedModel,
  };
}

/**
 * Devuelve la instrucción de sistema activa enriquecida con la fecha actual de Venezuela.
 * @returns {string}
 */
export function getSystemInstruction() {
  const base =
    configuredSystemInstruction ||
    process.env.SYSTEM_INSTRUCTION ||
    DEFAULT_SYSTEM_INSTRUCTION;
  return `${base}\n\nFecha actual (Venezuela): ${getCurrentDateVenezuela()}.`;
}

/**
 * Permite actualizar dinámicamente la instrucción de sistema en tiempo de ejecución.
 * @param {string} instruction
 */
export function setSystemInstruction(instruction) {
  if (typeof instruction !== 'string' || !instruction.trim()) {
    throw new Error('systemInstruction debe ser una cadena de texto no vacía.');
  }
  configuredSystemInstruction = instruction.trim();
}

/**
 * Obtiene una copia del historial de conversación de un chat.
 * @param {string} chatId
 * @returns {Array<object>}
 */
export function getConversationHistory(chatId) {
  return [...(conversationStore.get(chatId) || [])];
}

/**
 * Limpia el historial en memoria de un chat.
 * @param {string} chatId
 */
export function clearConversationHistory(chatId) {
  conversationStore.delete(chatId);
}

/**
 * Recorta el historial para conservar como máximo los últimos `MAX_HISTORY_MESSAGES` mensajes,
 * asegurando que la ventana siempre comience con un mensaje de usuario (`user_input`).
 * @param {Array<object>} history
 * @returns {Array<object>}
 */
function trimHistory(history) {
  let trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  while (trimmed.length > 0 && trimmed[0].type !== 'user_input') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

/**
 * Ordena los modelos candidatos priorizando los que no estén en enfriamiento.
 * Si la solicitud lleva contenido multimodal nativo (PDF o imagen), prioriza modelos Gemini.
 * @param {string} primaryModel
 * @param {boolean} requiresNativeMultimodal
 * @returns {string[]}
 */
function getOrderedCandidateModels(primaryModel, requiresNativeMultimodal) {
  let all = [...new Set([primaryModel, ...FALLBACK_MODELS])];
  if (requiresNativeMultimodal) {
    all = all.filter((m) => m.startsWith('gemini-'));
  }

  const now = Date.now();
  const ready = [];
  const cooling = [];

  for (const model of all) {
    const until = modelCooldownUntil.get(model) || 0;
    if (until > now) {
      cooling.push(model);
    } else {
      ready.push(model);
    }
  }

  return [...ready, ...cooling];
}

/**
 * Registra un enfriamiento temporal si el modelo devolvió 404, 429, 503 o timeout.
 * @param {string} model
 * @param {any} error
 */
function markModelFailure(model, error) {
  const status = error?.status || error?.statusCode || error?.rawResponse?.status;
  const msg = String(error?.message || '').toLowerCase();

  if (status === 404 || msg.includes('not found')) {
    modelCooldownUntil.set(model, Date.now() + COOLDOWN_404_MS);
  } else if (status === 429 || msg.includes('rate limit') || msg.includes('quota')) {
    modelCooldownUntil.set(model, Date.now() + COOLDOWN_429_MS);
  } else if (
    status === 503 ||
    status === 504 ||
    msg.includes('high demand') ||
    msg.includes('unavailable') ||
    msg.includes('timeout')
  ) {
    modelCooldownUntil.set(model, Date.now() + COOLDOWN_503_MS);
  }
}

/**
 * Construye los parámetros de la llamada a Interactions API con razonamiento fuerte.
 */
function buildRequestParams(model, systemInstruction, inputSteps) {
  const params = {
    model,
    system_instruction: systemInstruction,
    store: false,
    input: inputSteps,
  };

  if (model.includes('flash-lite')) {
    params.generation_config = { thinking_level: 'high' };
  } else if (model.startsWith('gemini-3') || model.startsWith('gemini-4')) {
    params.generation_config = { thinking_level: 'medium' };
  }

  return params;
}

/**
 * Llama a Interactions API sin reintentos internos lentos del SDK para cambiar rápido al respaldo.
 */
async function createInteractionFast(client, params) {
  let timer;
  try {
    return await Promise.race([
      client.interactions.create(params, {
        retries: { strategy: 'none' },
        timeout_ms: REQUEST_TIMEOUT_MS,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(
            `Tiempo de espera agotado (${REQUEST_TIMEOUT_MS}ms) para ${params.model}`
          );
          err.status = 504;
          reject(err);
        }, REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Construye el paso `user_input` para enviar en esta llamada (con imagen, documento o búsqueda web)
 * y la versión ligera para guardar en memoria.
 */
function buildUserSteps(userMessage, document, webContext) {
  const enrichedPrompt = webContext
    ? `${webContext}\n\nPregunta del usuario: ${userMessage}`
    : userMessage;

  if (!document) {
    return {
      requestStep: {
        type: 'user_input',
        content: [{ type: 'text', text: enrichedPrompt }],
      },
      historyStep: {
        type: 'user_input',
        content: [{ type: 'text', text: userMessage }],
      },
      requiresNativeMultimodal: false,
    };
  }

  if (document.kind === 'native_image') {
    return {
      requestStep: {
        type: 'user_input',
        content: [
          {
            type: 'image',
            mime_type: document.mimeType,
            data: document.base64,
          },
          {
            type: 'text',
            text: enrichedPrompt,
          },
        ],
      },
      historyStep: {
        type: 'user_input',
        content: [
          {
            type: 'text',
            text: `[Imagen adjunta: "${document.fileName}"]\n${userMessage}`,
          },
        ],
      },
      requiresNativeMultimodal: true,
    };
  }

  if (document.kind === 'native_document') {
    return {
      requestStep: {
        type: 'user_input',
        content: [
          {
            type: 'document',
            mime_type: document.mimeType,
            data: document.base64,
          },
          {
            type: 'text',
            text: `Archivo adjunto: "${document.fileName}".\nSolicitud del usuario: ${enrichedPrompt}`,
          },
        ],
      },
      historyStep: {
        type: 'user_input',
        content: [
          {
            type: 'text',
            text: `[PDF adjunto: "${document.fileName}"]\n${userMessage}`,
          },
        ],
      },
      requiresNativeMultimodal: true,
    };
  }

  const truncationNote = document.truncated
    ? '\n[Nota: el contenido del archivo era muy extenso y fue recortado al límite máximo.]'
    : '';

  const fullText =
    `[Documento ${document.format}: "${document.fileName}"]\n` +
    `--- INICIO DEL CONTENIDO ---\n${document.text}${truncationNote}\n--- FIN DEL CONTENIDO ---\n\n` +
    `Solicitud del usuario: ${enrichedPrompt}`;

  const excerpt =
    document.text.length > MAX_HISTORY_DOC_EXCERPT
      ? `${document.text.slice(0, MAX_HISTORY_DOC_EXCERPT)}... [extracto recortado en memoria]`
      : document.text;

  const historyText =
    `[Documento ${document.format}: "${document.fileName}"]\n` +
    `Extracto:\n${excerpt}\n\nSolicitud del usuario: ${userMessage}`;

  return {
    requestStep: {
      type: 'user_input',
      content: [{ type: 'text', text: fullText }],
    },
    historyStep: {
      type: 'user_input',
      content: [{ type: 'text', text: historyText }],
    },
    requiresNativeMultimodal: false,
  };
}

/**
 * Genera una respuesta de Gemini manteniendo los últimos 20 mensajes por chat.
 * Soporta visión de imágenes/fotos, PDF nativo, Word (.docx), PowerPoint (.pptx),
 * búsqueda en internet en vivo para temas actuales y respaldo rápido entre modelos.
 *
 * @param {string} chatId - Identificador del chat (clave en el Map de memoria).
 * @param {string} userMessage - Texto del mensaje entrante.
 * @param {object} [options]
 * @param {string} [options.systemInstruction] - Sobrescribe la instrucción de sistema solo para esta llamada.
 * @param {string} [options.model] - Sobrescribe el modelo solo para esta llamada.
 * @param {object} [options.document] - Resultado de `prepareDocumentForGemini` (imagen o documento).
 * @param {boolean} [options.disableWebSearch] - Desactiva la búsqueda web automática si es true.
 * @returns {Promise<string>} Respuesta generada en texto plano.
 */
export async function generateReply(chatId, userMessage, options = {}) {
  const client = getClient();
  const primaryModel = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const systemInstruction = options.systemInstruction || getSystemInstruction();

  let webContext = null;
  if (!options.document && !options.disableWebSearch && shouldSearchWeb(userMessage)) {
    try {
      webContext = await searchWebLive(userMessage);
      if (webContext) {
        console.log('[WebSearch] Contexto actualizado obtenido en vivo.');
      }
    } catch (err) {
      console.warn(`[WebSearch] Error en búsqueda web (se continúa sin búsqueda): ${err.message}`);
    }
  }

  const history = conversationStore.get(chatId) || [];
  const { requestStep, historyStep, requiresNativeMultimodal } = buildUserSteps(
    userMessage,
    options.document,
    webContext
  );

  const candidateModels = getOrderedCandidateModels(primaryModel, requiresNativeMultimodal);
  const inputSteps = trimHistory([...history, requestStep]);

  let interaction = null;
  let lastError = null;

  for (const model of candidateModels) {
    try {
      const params = buildRequestParams(model, systemInstruction, inputSteps);
      interaction = await createInteractionFast(client, params);
      modelCooldownUntil.delete(model);
      lastUsedModel = model;
      if (model !== primaryModel) {
        console.warn(
          `[Gemini] Modelo principal (${primaryModel}) no disponible; respuesta generada con ${model}.`
        );
      } else {
        console.log(`[Gemini] Respuesta generada con ${model}.`);
      }
      break;
    } catch (error) {
      lastError = error;
      markModelFailure(model, error);
      console.warn(`[Gemini] Falló modelo ${model}: ${error?.message || error}`);
    }
  }

  if (!interaction) {
    throw lastError || new Error('Ningún modelo de Gemini pudo responder.');
  }

  const replyText =
    interaction.output_text?.trim() ||
    'Epa, no pude armar una respuesta ahorita. Intenta de nuevo en un momento.';

  const modelStep = {
    type: 'model_output',
    content: [{ type: 'text', text: replyText }],
  };

  conversationStore.set(chatId, trimHistory([...history, historyStep, modelStep]));

  return replyText;
}
