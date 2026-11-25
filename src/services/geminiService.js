import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
];
const REQUEST_TIMEOUT_MS = 12000;
const COOLDOWN_429_MS = 10 * 60 * 1000; // 10 min si excede cuota/rate limit
const COOLDOWN_503_MS = 60 * 1000; // 1 min si hay saturación temporal o timeout
const DEFAULT_SYSTEM_INSTRUCTION =
  'Eres un asistente virtual amable, claro y conciso que responde mensajes por WhatsApp en español. ' +
  'Mantén tus respuestas breves, útiles y fáciles de leer en un teléfono móvil.';
const MAX_HISTORY_MESSAGES = 10;

// Memoria de conversación en memoria: Map<phoneNumber, Array<InteractionStep>>
const conversationStore = new Map();
// Enfriamiento temporal por modelo que falló recientemente: Map<model, timestampMs>
const modelCooldownUntil = new Map();

let aiClient = null;
let configuredSystemInstruction = null;

/**
 * Inicializa (de forma perezosa) el cliente oficial de Google GenAI.
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
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

/**
 * Devuelve la instrucción de sistema activa.
 * @returns {string}
 */
export function getSystemInstruction() {
  return (
    configuredSystemInstruction ||
    process.env.SYSTEM_INSTRUCTION ||
    DEFAULT_SYSTEM_INSTRUCTION
  );
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
 * Obtiene una copia del historial de conversación de un número de teléfono.
 * @param {string} phoneNumber
 * @returns {Array<object>}
 */
export function getConversationHistory(phoneNumber) {
  return [...(conversationStore.get(phoneNumber) || [])];
}

/**
 * Limpia el historial en memoria de un número de teléfono.
 * @param {string} phoneNumber
 */
export function clearConversationHistory(phoneNumber) {
  conversationStore.delete(phoneNumber);
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
 * @param {string} primaryModel
 * @returns {string[]}
 */
function getOrderedCandidateModels(primaryModel) {
  const all = [...new Set([primaryModel, ...FALLBACK_MODELS])];
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
 * Registra un enfriamiento temporal si el modelo devolvió 429, 503 o timeout.
 * @param {string} model
 * @param {any} error
 */
function markModelFailure(model, error) {
  const status = error?.status || error?.statusCode || error?.rawResponse?.status;
  const msg = String(error?.message || '').toLowerCase();

  if (status === 429 || msg.includes('rate limit') || msg.includes('quota')) {
    modelCooldownUntil.set(model, Date.now() + COOLDOWN_429_MS);
  } else if (status === 503 || status === 504 || msg.includes('high demand') || msg.includes('unavailable') || msg.includes('timeout')) {
    modelCooldownUntil.set(model, Date.now() + COOLDOWN_503_MS);
  }
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
          const err = new Error(`Tiempo de espera agotado (${REQUEST_TIMEOUT_MS}ms) para ${params.model}`);
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
 * Genera una respuesta de Gemini manteniendo los últimos 10 mensajes por número de teléfono.
 * Incluye respaldo automático rápido entre múltiples modelos y enfriamiento por 429/503.
 *
 * @param {string} phoneNumber - Número de teléfono del usuario (clave en el Map de memoria).
 * @param {string} userMessage - Texto del mensaje entrante.
 * @param {object} [options]
 * @param {string} [options.systemInstruction] - Sobrescribe la instrucción de sistema solo para esta llamada.
 * @param {string} [options.model] - Sobrescribe el modelo solo para esta llamada.
 * @returns {Promise<string>} Respuesta generada en texto plano.
 */
export async function generateReply(phoneNumber, userMessage, options = {}) {
  const client = getClient();
  const primaryModel = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const candidateModels = getOrderedCandidateModels(primaryModel);
  const systemInstruction = options.systemInstruction || getSystemInstruction();

  const history = conversationStore.get(phoneNumber) || [];
  const userStep = {
    type: 'user_input',
    content: [{ type: 'text', text: userMessage }],
  };

  const inputSteps = trimHistory([...history, userStep]);

  let interaction = null;
  let lastError = null;

  for (const model of candidateModels) {
    try {
      interaction = await createInteractionFast(client, {
        model,
        system_instruction: systemInstruction,
        store: false,
        input: inputSteps,
      });
      modelCooldownUntil.delete(model);
      if (model !== primaryModel) {
        console.warn(`[Gemini] Modelo principal (${primaryModel}) no disponible; respuesta generada con ${model}.`);
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
    'Lo siento, no pude generar una respuesta en este momento. ¿Podrías intentar de nuevo?';

  const modelStep = {
    type: 'model_output',
    content: [{ type: 'text', text: replyText }],
  };

  conversationStore.set(phoneNumber, trimHistory([...inputSteps, modelStep]));

  return replyText;
}
