import AdmZip from 'adm-zip';
import mammoth from 'mammoth';

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_EXTRACTED_CHARS = 120_000;

const MIME_PDF = 'application/pdf';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MIME_DOC_LEGACY = 'application/msword';
const MIME_PPT_LEGACY = 'application/vnd.ms-powerpoint';

/**
 * Error controlado para documentos no soportados o demasiado grandes.
 */
export class UnsupportedDocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedDocumentError';
  }
}

/**
 * Decodifica entidades XML comunes presentes en archivos .pptx.
 * @param {string} text
 * @returns {string}
 */
function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Extrae el texto legible de un archivo XML de diapositiva o nota de PowerPoint.
 * @param {string} xml
 * @returns {string}
 */
function extractTextFromSlideXml(xml) {
  const paragraphs = xml.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) || [];
  const lines = [];

  for (const paragraph of paragraphs) {
    const textRuns = paragraph.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g) || [];
    if (textRuns.length === 0) continue;

    const line = textRuns
      .map((run) => decodeXmlEntities(run.replace(/<\/?a:t\b[^>]*>/g, '')))
      .join('')
      .trim();

    if (line) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

/**
 * Extrae texto ordenado por número de diapositiva (y notas del presentador) desde un .pptx.
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extractPptxText(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const slideEntries = entries
    .map((entry) => {
      const match = entry.entryName.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
      return match ? { num: Number(match[1]), entry } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.num - b.num);

  if (slideEntries.length === 0) {
    throw new UnsupportedDocumentError('No encontré diapositivas legibles dentro de ese archivo PowerPoint.');
  }

  const notesBySlide = new Map();
  for (const entry of entries) {
    const match = entry.entryName.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/i);
    if (match) {
      const xml = entry.getData().toString('utf8');
      const noteText = extractTextFromSlideXml(xml);
      if (noteText) {
        notesBySlide.set(Number(match[1]), noteText);
      }
    }
  }

  const sections = slideEntries.map(({ num, entry }) => {
    const xml = entry.getData().toString('utf8');
    const slideText = extractTextFromSlideXml(xml) || '(Diapositiva sin texto)';
    const note = notesBySlide.get(num);
    return note
      ? `--- Diapositiva ${num} ---\n${slideText}\n[Notas del presentador]: ${note}`
      : `--- Diapositiva ${num} ---\n${slideText}`;
  });

  return sections.join('\n\n').trim();
}

/**
 * Extrae el texto plano de un documento Word (.docx) usando mammoth.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractDocxText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return (value || '').trim();
}

/**
 * Determina el tipo lógico del archivo adjunto a partir del MIME type y la extensión.
 * @param {string} [mimeType]
 * @param {string} [fileName]
 * @returns {'image' | 'pdf' | 'docx' | 'pptx' | 'text' | 'legacy_office' | 'unsupported'}
 */
export function detectDocumentKind(mimeType = '', fileName = '') {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  const ext = String(fileName || '').toLowerCase().split('.').pop() || '';

  if (
    mime.startsWith('image/') ||
    ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)
  ) {
    return 'image';
  }
  if (mime === MIME_PDF || ext === 'pdf') return 'pdf';
  if (mime === MIME_DOCX || ext === 'docx') return 'docx';
  if (mime === MIME_PPTX || ext === 'pptx') return 'pptx';
  if (mime === MIME_DOC_LEGACY || mime === MIME_PPT_LEGACY || ext === 'doc' || ext === 'ppt') {
    return 'legacy_office';
  }
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    ['txt', 'csv', 'md', 'json'].includes(ext)
  ) {
    return 'text';
  }

  return 'unsupported';
}

/**
 * Normaliza el MIME type de una imagen para enviarla a Gemini.
 */
function resolveImageMimeType(mimeType = '', fileName = '') {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) {
    return mime;
  }
  const ext = String(fileName || '').toLowerCase().split('.').pop() || '';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

/**
 * Prepara un archivo o imagen descargado de WhatsApp para enviarlo a Gemini:
 * - Imagen (JPG/PNG/WEBP/GIF) -> visión multimodal nativa
 * - PDF -> envío multimodal nativo (lee texto, tablas e imágenes/gráficos)
 * - Word (.docx) -> extracción limpia de texto con mammoth
 * - PowerPoint (.pptx) -> extracción de diapositivas y notas en orden con adm-zip
 * - Texto plano (.txt/.csv/.md/.json) -> lectura UTF-8 directa
 *
 * @param {Buffer} buffer
 * @param {{ mimeType?: string, fileName?: string }} metadata
 * @returns {Promise<
 *   | { kind: 'native_image', mimeType: string, base64: string, fileName: string }
 *   | { kind: 'native_document', mimeType: string, base64: string, fileName: string }
 *   | { kind: 'extracted_text', format: string, text: string, fileName: string, truncated: boolean }
 * >}
 */
export async function prepareDocumentForGemini(buffer, { mimeType = '', fileName = 'archivo' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new UnsupportedDocumentError('El archivo llegó vacío o no se pudo descargar.');
  }

  if (buffer.length > MAX_DOCUMENT_BYTES) {
    const maxMb = Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024));
    throw new UnsupportedDocumentError(
      `El archivo "${fileName}" pesa más de ${maxMb} MB. Envíame una versión más liviana para analizarlo.`
    );
  }

  const kind = detectDocumentKind(mimeType, fileName);

  if (kind === 'image') {
    return {
      kind: 'native_image',
      mimeType: resolveImageMimeType(mimeType, fileName),
      base64: buffer.toString('base64'),
      fileName,
    };
  }

  if (kind === 'pdf') {
    return {
      kind: 'native_document',
      mimeType: MIME_PDF,
      base64: buffer.toString('base64'),
      fileName,
    };
  }

  if (kind === 'docx') {
    const rawText = await extractDocxText(buffer);
    if (!rawText) {
      throw new UnsupportedDocumentError(
        `El documento Word "${fileName}" no tiene texto extraíble (puede ser solo imágenes escaneadas).`
      );
    }
    const truncated = rawText.length > MAX_EXTRACTED_CHARS;
    return {
      kind: 'extracted_text',
      format: 'Word (.docx)',
      text: truncated ? rawText.slice(0, MAX_EXTRACTED_CHARS) : rawText,
      fileName,
      truncated,
    };
  }

  if (kind === 'pptx') {
    const rawText = extractPptxText(buffer);
    if (!rawText) {
      throw new UnsupportedDocumentError(
        `La presentación "${fileName}" no tiene texto extraíble.`
      );
    }
    const truncated = rawText.length > MAX_EXTRACTED_CHARS;
    return {
      kind: 'extracted_text',
      format: 'PowerPoint (.pptx)',
      text: truncated ? rawText.slice(0, MAX_EXTRACTED_CHARS) : rawText,
      fileName,
      truncated,
    };
  }

  if (kind === 'text') {
    const rawText = buffer.toString('utf8').trim();
    if (!rawText) {
      throw new UnsupportedDocumentError(`El archivo "${fileName}" está vacío.`);
    }
    const truncated = rawText.length > MAX_EXTRACTED_CHARS;
    return {
      kind: 'extracted_text',
      format: 'Texto',
      text: truncated ? rawText.slice(0, MAX_EXTRACTED_CHARS) : rawText,
      fileName,
      truncated,
    };
  }

  if (kind === 'legacy_office') {
    throw new UnsupportedDocumentError(
      `El formato antiguo de "${fileName}" (.doc / .ppt) no es compatible directamente. Guárdalo como .docx, .pptx o .pdf y reenvíamelo con !.`
    );
  }

  throw new UnsupportedDocumentError(
    `Todavía no puedo leer el formato de "${fileName}". Soporto *fotos/imágenes*, *PDF*, *Word (.docx)*, *PowerPoint (.pptx)* y texto (.txt/.csv/.md).`
  );
}
