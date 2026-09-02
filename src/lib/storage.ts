/**
 * Thin AsyncStorage wrapper. All keys are namespaced `gagyebu.*` to match
 * the web version's localStorage layout, which keeps the text backup /
 * restore format compatible between platforms.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'gagyebu.';

export const storageKey = (k: string): string => PREFIX + k;

export async function loadItem<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(key));
    return raw != null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function saveItem<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // best-effort; storage full or unavailable
  }
}

/** Load many keys in one round-trip. */
export async function loadMany<T extends Record<string, unknown>>(
  defaults: T,
): Promise<T> {
  const keys = Object.keys(defaults);
  try {
    const pairs = await AsyncStorage.multiGet(keys.map(storageKey));
    const out = { ...defaults };
    pairs.forEach(([namespaced, raw], i) => {
      if (raw != null) {
        try {
          (out as Record<string, unknown>)[keys[i]] = JSON.parse(raw);
        } catch {
          // keep default
        }
      }
    });
    return out;
  } catch {
    return { ...defaults };
  }
}

export const STORAGE_KEYS = [
  'seen',
  'txns',
  'budgets',
  'goals',
  'recurring',
  'planned',
  'loans',
  'notes',
  'customCats',
  'catOrder',
  'settings',
  'schemaVersion',
] as const;

export type StorageKey = (typeof STORAGE_KEYS)[number];
