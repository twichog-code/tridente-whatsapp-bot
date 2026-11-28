const SEARCH_TIMEOUT_MS = 8000;
const WIKI_USER_AGENT =
  'TridenteWhatsAppBot/1.0 (https://github.com/twichog-code/tridente-whatsapp-bot)';

const EXPLICIT_SEARCH_REGEX = /^(busca|buscar|investiga|investigar|noticias|googlea)\b/i;

const VENEZUELA_EXPLICIT_CURRENCY_REGEX =
  /(?<![\p{L}\p{N}])(bcv|paralelo|bolívares|bolivares|bolívar|bolivar|bs\.?|tasa\s+de\s+cambio|divisa|divisas)(?![\p{L}\p{N}])/iu;

const GENERAL_CURRENCY_WORD_REGEX =
  /(?<![\p{L}\p{N}])(dólar|dolar|dólares|dolares|euro|euros)(?![\p{L}\p{N}])/iu;

const FINANCE_TOPIC_REGEX =
  /(?<![\p{L}\p{N}])(fondo|fondos|inversión|inversion|inversiones|bolsa|acción|acciones|etf|s&p|nasdaq|dow\s+jones|fed|reserva\s+federal|inflación|inflacion|tasa\s+de\s+interés|tasas\s+de\s+interés|bitcoin|btc|ethereum|eth|cripto|oro|petróleo|petroleo|mercado\s+financiero|wall\s+street|blackrock|vanguard)(?![\p{L}\p{N}])/iu;

const FRESHNESS_QUERY_REGEX =
  /(?<![\p{L}\p{N}])(202[5-9]|203\d|hoy|ayer|anoche|mañana|actual|actualmente|ahora|reciente|recientes|últim[oa]s?|ultim[oa]s?|notici[ao]s?|precio|precios|tasa|tasas|dólar|dolar|bcv|euro|bitcoin|btc|clima|tiempo|pronóstico|pronostico|partido|marcador|resultado|resultados|ganó|gano|ganador|ganadora|campeón|campeon|campeona|presidente|presidenta|ministro|miss|mundial|estreno|película|pelicula|vigente|quién\s+es|quien\s+es|cuánto\s+cuesta|cuanto\s+cuesta|cuánto\s+vale|cuanto\s+vale|cuándo\s+es|cuando\s+es|qué\s+pasó|que\s+paso)(?![\p{L}\p{N}])/iu;

/**
 * Determina si el mensaje pregunta específicamente por las tasas de cambio en Venezuela (BCV/Paralelo).
 * Evita secuestrar preguntas globales como "precio del bitcoin en dólares" o "fondos en dólares de EE.UU.".
 * @param {string} text
 * @returns {boolean}
 */
function isVenezuelaCurrencyQuery(text) {
  if (VENEZUELA_EXPLICIT_CURRENCY_REGEX.test(text)) return true;
  if (!GENERAL_CURRENCY_WORD_REGEX.test(text)) return false;
  // Si menciona temas financieros globales (bitcoin, fondos, acciones, petróleo, etc.) o países/productos externos, dejar que Tavily responda
  if (FINANCE_TOPIC_REGEX.test(text)) return false;
  if (
    /(?<![\p{L}\p{N}])(estados\s+unidos|ee\.?uu\.?|europa|españa|colombia|méxico|mexico|argentina|chile|perú|peru|brasil|iphone|samsung|carro|casa|play\s*station|ps5|xbox|laptop|vuelo|pasaje)(?![\p{L}\p{N}])/iu.test(
      text
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Devuelve el motor de búsqueda web configurado ('tavily' o 'free_rss').
 * @returns {'tavily' | 'free_rss'}
 */
export function getWebSearchMode() {
  return process.env.TAVILY_API_KEY?.trim() ? 'tavily' : 'free_rss';
}

/**
 * Decodifica entidades HTML/XML básicas presentes en feeds RSS y respuestas de Wikipedia.
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => {
      const cp = Number(code);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const cp = parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Devuelve la fecha actual formateada en español (zona horaria Venezuela).
 * @returns {string}
 */
export function getCurrentDateVenezuela() {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
}

/**
 * Decide si una pregunta requiere búsqueda web en tiempo real.
 * @param {string} prompt
 * @returns {boolean}
 */
export function shouldSearchWeb(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return false;
  const text = prompt.trim();
  if (text.length < 4) return false;

  if (EXPLICIT_SEARCH_REGEX.test(text)) return true;
  if (isVenezuelaCurrencyQuery(text)) return true;
  if (FINANCE_TOPIC_REGEX.test(text)) return true;
  if (FRESHNESS_QUERY_REGEX.test(text)) return true;

  return false;
}

/**
 * Limpia el prompt del usuario para generar una consulta de búsqueda enfocada.
 * @param {string} prompt
 * @returns {string}
 */
export function buildSearchQuery(prompt) {
  return String(prompt || '')
    .replace(EXPLICIT_SEARCH_REGEX, '')
    .replace(/[¿?¡!"]/g, ' ')
    .replace(
      /(?<![\p{L}\p{N}])(por favor|dime|cuéntame|cuentame|sabes|me puedes decir|en internet|en google|a cuánto está|a cuanto esta|en cuánto está|en cuanto esta|cuánto está|cuanto esta|cuál es|cual es|quién es|quien es|qué es|que es)(?![\p{L}\p{N}])/giu,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Búsqueda web completa en todo internet usando Tavily API (`TAVILY_API_KEY`).
 * Lee resúmenes y fragmentos reales de páginas web actualizadas de todo el mundo.
 * @param {string} query
 * @returns {Promise<string | null>}
 */
async function fetchTavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) return null;

  const topic = FINANCE_TOPIC_REGEX.test(query) ? 'finance' : 'general';

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      topic,
      include_answer: true,
      max_results: 5,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Tavily HTTP ${res.status}: ${errText.slice(0, 160)}`);
  }

  const data = await res.json();
  const sections = [];

  if (typeof data.answer === 'string' && data.answer.trim()) {
    sections.push(`Resumen verificado (Tavily):\n${data.answer.trim()}`);
  }

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length > 0) {
    const formatted = results.slice(0, 5).map((r, idx) => {
      const title = r.title || 'Fuente web';
      const dateStr = r.published_date ? ` (${r.published_date})` : '';
      const snippet = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      return `${idx + 1}. ${title}${dateStr}\n   ${snippet}\n   URL: ${r.url || ''}`;
    });
    sections.push(`Páginas web encontradas:\n${formatted.join('\n\n')}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

/**
 * Consulta tasas oficiales (BCV) y paralelo en tiempo real para Venezuela (USD y EUR) vía DolarAPI.
 * @returns {Promise<string | null>}
 */
async function fetchVenezuelaRates() {
  const [usdRes, eurRes] = await Promise.allSettled([
    fetch('https://ve.dolarapi.com/v1/dolares', {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    }).then((r) => (r.ok ? r.json() : null)),
    fetch('https://ve.dolarapi.com/v1/euros', {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    }).then((r) => (r.ok ? r.json() : null)),
  ]);

  const usdList = usdRes.status === 'fulfilled' && Array.isArray(usdRes.value) ? usdRes.value : [];
  const eurList = eurRes.status === 'fulfilled' && Array.isArray(eurRes.value) ? eurRes.value : [];

  const lines = [];
  const formatRate = (label, item, unit) => {
    if (!item || typeof item.promedio !== 'number') return;
    let updated = 'hoy';
    if (item.fechaActualizacion) {
      const parsedDate = new Date(item.fechaActualizacion);
      if (!Number.isNaN(parsedDate.getTime())) {
        updated = new Intl.DateTimeFormat('es-VE', {
          timeZone: 'America/Caracas',
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(parsedDate);
      }
    }
    lines.push(`- ${label}: ${item.promedio.toFixed(4)} Bs/${unit} (actualizado: ${updated})`);
  };

  formatRate('Dólar BCV (Oficial)', usdList.find((x) => x.fuente === 'oficial'), 'USD');
  formatRate('Dólar Paralelo', usdList.find((x) => x.fuente === 'paralelo'), 'USD');
  formatRate('Euro BCV (Oficial)', eurList.find((x) => x.fuente === 'oficial'), 'EUR');
  formatRate('Euro Paralelo', eurList.find((x) => x.fuente === 'paralelo'), 'EUR');

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Consulta titulares recientes en español vía Google News RSS (región Venezuela).
 * @param {string} query
 * @returns {Promise<Array<{ title: string, date: string }>>}
 */
async function fetchGoogleNewsRss(query) {
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    '&hl=es-419&gl=VE&ceid=VE:es-419';

  const res = await fetch(url, {
    headers: { 'User-Agent': WIKI_USER_AGENT },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) return [];
  const xml = await res.text();

  const items = [];
  const matches = xml.matchAll(
    /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/g
  );

  for (const match of matches) {
    const title = decodeHtmlEntities(match[1]);
    const rawDate = decodeHtmlEntities(match[2]);
    if (!title) continue;

    const parsed = new Date(rawDate);
    const timestamp = Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
    let formattedDate = rawDate;
    if (timestamp > 0) {
      formattedDate = new Intl.DateTimeFormat('es-VE', {
        timeZone: 'America/Caracas',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(parsed);
    }

    items.push({ title, date: formattedDate, timestamp });
    if (items.length >= 15) break;
  }

  items.sort((a, b) => b.timestamp - a.timestamp);
  return items.slice(0, 8).map(({ title, date }) => ({ title, date }));
}

/**
 * Consulta Wikipedia en español (búsqueda + extracto introductorio del artículo más relevante).
 * @param {string} query
 * @returns {Promise<{ extracts: string[], snippets: string[] } | null>}
 */
async function fetchWikipediaEs(query) {
  const searchUrl =
    'https://es.wikipedia.org/w/api.php?action=query&list=search' +
    `&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&utf8=1`;

  const res = await fetch(searchUrl, {
    headers: { 'User-Agent': WIKI_USER_AGENT },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) return null;
  const json = await res.json();
  const hits = json?.query?.search || [];
  if (hits.length === 0) return null;

  const snippets = hits.map(
    (h) => `${h.title}: ${decodeHtmlEntities(h.snippet)}`
  );

  const titles = hits.slice(0, 2).map((h) => h.title).join('|');
  const extractUrl =
    'https://es.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exchars=750' +
    `&titles=${encodeURIComponent(titles)}&format=json&utf8=1`;

  const exRes = await fetch(extractUrl, {
    headers: { 'User-Agent': WIKI_USER_AGENT },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  const extracts = [];
  if (exRes.ok) {
    const exJson = await exRes.json();
    const pages = Object.values(exJson?.query?.pages || {});
    for (const page of pages) {
      if (page?.title && page?.extract) {
        extracts.push(`${page.title}: ${page.extract.trim()}`);
      }
    }
  }

  return {
    extracts,
    snippets,
  };
}

/**
 * Ejecuta búsqueda en vivo con prioridad:
 * 1. Tasas exactas BCV/Paralelo (USD/EUR) vía DolarAPI si preguntan por divisas de Venezuela.
 * 2. Tavily Search (búsqueda web completa global) si `TAVILY_API_KEY` está configurada.
 * 3. Respaldo gratuito automático: Google News RSS + Wikipedia ES en paralelo.
 *
 * @param {string} prompt
 * @returns {Promise<string | null>}
 */
export async function searchWebLive(prompt) {
  const isCurrencyQuery = isVenezuelaCurrencyQuery(prompt);

  if (isCurrencyQuery) {
    try {
      const ratesBlock = await fetchVenezuelaRates();
      if (ratesBlock) {
        return (
          `[RESULTADOS DE BÚSQUEDA EN INTERNET EN VIVO — Tasas de Cambio Venezuela (DolarAPI / BCV) | Fecha actual: ${getCurrentDateVenezuela()}]\n` +
          `Tasas exactas vigentes ahora mismo:\n${ratesBlock}\n` +
          '[FIN DE RESULTADOS DE BÚSQUEDA]'
        );
      }
    } catch {
      // Si falla DolarAPI, continúa con Tavily o Google News RSS
    }
  }

  const query = buildSearchQuery(prompt);
  if (!query) return null;

  // Prioridad 1: Tavily (búsqueda web completa global leyendo contenido real de páginas)
  if (process.env.TAVILY_API_KEY?.trim()) {
    try {
      const tavilyBlock = await fetchTavilySearch(query);
      if (tavilyBlock) {
        return (
          `[RESULTADOS DE BÚSQUEDA EN INTERNET EN VIVO (Tavily Web Search) — Consulta: "${query}" | Fecha actual: ${getCurrentDateVenezuela()}]\n` +
          `${tavilyBlock}\n` +
          '[FIN DE RESULTADOS DE BÚSQUEDA]'
        );
      }
    } catch (err) {
      console.warn(`[WebSearch] Falló Tavily (${err.message}); usando respaldo Google News + Wikipedia.`);
    }
  }

  // Respaldo gratuito automático: Google News RSS + Wikipedia ES
  const wikiQuery = /\b2026\b/.test(query) ? `${query} 2025` : query;

  const [newsRes, wikiRes] = await Promise.allSettled([
    fetchGoogleNewsRss(query),
    fetchWikipediaEs(wikiQuery),
  ]);

  const newsItems = newsRes.status === 'fulfilled' ? newsRes.value : [];
  const wikiData = wikiRes.status === 'fulfilled' ? wikiRes.value : null;

  const sections = [];

  if (newsItems.length > 0) {
    const lines = newsItems.map((item) => `- [${item.date}] ${item.title}`);
    sections.push(`Noticias recientes (Google News):\n${lines.join('\n')}`);
  }

  if (wikiData?.extracts?.length > 0) {
    sections.push(`Resúmenes de Wikipedia (ES):\n${wikiData.extracts.join('\n\n')}`);
  } else if (wikiData?.snippets?.length > 0) {
    sections.push(`Referencias de Wikipedia (ES):\n- ${wikiData.snippets.join('\n- ')}`);
  }

  if (sections.length === 0) {
    return null;
  }

  return (
    `[RESULTADOS DE BÚSQUEDA EN INTERNET EN VIVO — Consulta: "${query}" | Fecha actual: ${getCurrentDateVenezuela()}]\n` +
    sections.join('\n\n') +
    '\n[FIN DE RESULTADOS DE BÚSQUEDA]'
  );
}
