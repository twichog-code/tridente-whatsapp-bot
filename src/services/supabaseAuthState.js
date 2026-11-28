import { createClient } from '@supabase/supabase-js';
import {
  BufferJSON,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys';

const DEFAULT_TABLE = 'whatsapp_auth';
const CREDS_KEY = 'creds';

/**
 * Serializa datos de Baileys (incluyendo Buffers / Uint8Arrays) a un objeto JSON plano
 * compatible con columnas JSONB de PostgreSQL / Supabase.
 * @param {unknown} data
 * @returns {unknown}
 */
function serializeForJsonb(data) {
  return JSON.parse(JSON.stringify(data, BufferJSON.replacer));
}

/**
 * Deserializa un valor leído desde una columna JSONB de Supabase restaurando los Buffers
 * originales mediante BufferJSON.reviver.
 * @param {unknown} raw
 * @returns {any}
 */
function deserializeFromJsonb(raw) {
  if (raw === null || raw === undefined) return null;
  const jsonString = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return JSON.parse(jsonString, BufferJSON.reviver);
}

/**
 * Adaptador de estado de autenticación de Baileys respaldado por Supabase.
 *
 * SQL requerido en Supabase:
 * ```sql
 * CREATE TABLE IF NOT EXISTS whatsapp_auth (
 *   id TEXT PRIMARY KEY,
 *   data JSONB NOT NULL
 * );
 * ```
 *
 * @param {string} supabaseUrl - URL del proyecto de Supabase (`SUPABASE_URL`).
 * @param {string} supabaseKey - Clave de API de Supabase (`SUPABASE_KEY`, preferiblemente `service_role` en backend).
 * @param {object} [options]
 * @param {string} [options.tableName='whatsapp_auth'] - Nombre de la tabla.
 * @param {string} [options.sessionPrefix=''] - Prefijo opcional para soportar múltiples sesiones en la misma tabla.
 * @returns {Promise<{ state: { creds: any, keys: { get: Function, set: Function } }, saveCreds: Function }>}
 */
const BATCH_SIZE = 100;

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function useSupabaseAuthState(supabaseUrl, supabaseKey, options = {}) {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL y SUPABASE_KEY son obligatorias para usar useSupabaseAuthState.');
  }

  const tableName = options.tableName || DEFAULT_TABLE;
  const prefix = options.sessionPrefix ? `${options.sessionPrefix}:` : '';
  const buildId = (key) => `${prefix}${key}`;

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const writeRow = async (key, value) => {
    const id = buildId(key);
    const payload = { id, data: serializeForJsonb(value) };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { error } = await supabase
        .from(tableName)
        .upsert(payload, { onConflict: 'id' });

      if (!error) return;
      if (attempt === 2) {
        throw new Error(`Error guardando "${id}" en Supabase (${tableName}): ${error.message}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const readRow = async (key) => {
    const id = buildId(key);
    const { data, error } = await supabase
      .from(tableName)
      .select('data')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new Error(`Error leyendo "${id}" desde Supabase (${tableName}): ${error.message}`);
    }

    return data ? deserializeFromJsonb(data.data) : null;
  };

  const creds = (await readRow(CREDS_KEY)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          if (!Array.isArray(ids) || ids.length === 0) {
            return result;
          }

          const dbIdToKeyId = new Map();
          const dbIds = ids.map((id) => {
            const dbId = buildId(`${type}-${id}`);
            dbIdToKeyId.set(dbId, id);
            return dbId;
          });

          for (const batch of chunkArray(dbIds, BATCH_SIZE)) {
            const { data: rows, error } = await supabase
              .from(tableName)
              .select('id, data')
              .in('id', batch);

            if (error) {
              throw new Error(`Error consultando llaves "${type}" en Supabase: ${error.message}`);
            }

            for (const row of rows || []) {
              const originalId = dbIdToKeyId.get(row.id);
              if (!originalId) continue;

              let value = deserializeFromJsonb(row.data);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              result[originalId] = value;
            }
          }

          return result;
        },

        set: async (data) => {
          const rowsToUpsert = [];
          const idsToDelete = [];

          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const dbId = buildId(`${category}-${id}`);

              if (value !== null && value !== undefined) {
                rowsToUpsert.push({
                  id: dbId,
                  data: serializeForJsonb(value),
                });
              } else {
                idsToDelete.push(dbId);
              }
            }
          }

          const tasks = [];

          for (const batch of chunkArray(rowsToUpsert, BATCH_SIZE)) {
            tasks.push(
              supabase
                .from(tableName)
                .upsert(batch, { onConflict: 'id' })
                .then(({ error }) => {
                  if (error) {
                    throw new Error(`Error guardando llaves en Supabase: ${error.message}`);
                  }
                })
            );
          }

          for (const batch of chunkArray(idsToDelete, BATCH_SIZE)) {
            tasks.push(
              supabase
                .from(tableName)
                .delete()
                .in('id', batch)
                .then(({ error }) => {
                  if (error) {
                    throw new Error(`Error eliminando llaves en Supabase: ${error.message}`);
                  }
                })
            );
          }

          await Promise.all(tasks);
        },
      },
    },

    saveCreds: async () => {
      await writeRow(CREDS_KEY, creds);
    },
  };
}
