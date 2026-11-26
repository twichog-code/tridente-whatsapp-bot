const SEARCH_TIMEOUT_MS = 7000;
const WIKI_USER_AGENT =
  'TridenteWhatsAppBot/1.0 (https://github.com/twichog-code/tridente-whatsapp-bot)';

const EXPLICIT_SEARCH_REGEX = /^(busca|buscar|investiga|investigar|noticias|googlea)\b/i;

const FRESHNESS_QUERY_REGEX =
  /\b(202[5-9]|203\d|hoy|ayer|anoche|mañana|actual|actualmente|ahora|reciente|recientes|últim[oa]s?|ultim[oa]s?|notici[ao]s?|precio|tasa|dólar|dolar|bcv|euro|bitcoin|btc|clima|tiempo|pronóstico|pronostico|partido|marcador|resultado|resultados|ganó|gano|ganador|ganadora|campeón|campeon|campeona|presidente|presidenta|ministro|miss|mundial|estreno|película|pelicula|vigente|quién\s+es|quien\s+es|cuánto\s+cuesta|cuanto\s+cuesta|cuánto\s+vale|cuanto\s+vale|cuándo\s+es|cuando\s+es|qué\s+pasó|que\s+paso)\b/i;

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
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
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
    .slice(0, 140);
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

  // Priorizar las noticias más recientes (ej. hoy antes que hace 3 días)
  items.sort((a, b) => b.timestamp - a.timestamp);
  return items.slice(0, 8).map(({ title, date }) => ({ title, date }));
}

/**
 * Consulta Wikipedia en español (búsqueda + extracto introductorio del artículo más relevante).
 * @param {string} query
 * @returns {Promise<{ topTitle: string, extract: string, snippets: string[] } | null>}
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

  // Obtener extracto introductorio de los 2 artículos más relevantes
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
 * Ejecuta búsqueda en vivo (Google News RSS + Wikipedia ES en paralelo) sin requerir API Keys.
 * Devuelve un bloque de contexto listo para inyectar a Gemini, o `null` si no hubo resultados.
 *
 * @param {string} prompt
 * @returns {Promise<string | null>}
 */
export async function searchWebLive(prompt) {
  const query = buildSearchQuery(prompt);
  if (!query) return null;

  // Si la consulta menciona 2026 en certámenes/eventos anuales, consultamos también el ciclo 2025/2026 en Wikipedia
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
