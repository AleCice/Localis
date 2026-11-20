import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../api/client";
import type {
  AppError,
  CloudProviderId,
  KeyringStatus,
  ModelInfo,
  ModelPrice,
  ModelRef,
  ProviderInfo,
  ProviderModels,
} from "../api/types";
import { toAppError } from "../api/types";
import { isChatKind, isEmbeddingKind, sameRef } from "../lib/models";

export interface ProviderModelsState {
  loading: boolean;
  result: ProviderModels | null;
  error: AppError | null;
}

export interface CloudState {
  keyring: KeyringStatus | null;
  providers: ProviderInfo[] | null;
  prices: ModelPrice[] | null;
  loadError: AppError | null;
  /** Model lists fetched on explicit request in this session (the provider is contacted). */
  models: Partial<Record<CloudProviderId, ProviderModelsState>>;
}

export interface CloudStore {
  getState: () => CloudState;
  subscribe: (listener: () => void) => () => void;
  /** Reads keychain status, providers and prices (local only: no provider is contacted). */
  reload: () => Promise<void>;
  /** Stores a key; rejects with the AppError. The key is not kept anywhere in the UI. */
  setKey: (provider: CloudProviderId, key: string) => Promise<ProviderInfo>;
  deleteKey: (provider: CloudProviderId) => Promise<ProviderInfo>;
  /** Contacts the provider with its key to list its models. */
  loadModels: (provider: CloudProviderId) => Promise<void>;
  setPrice: (price: ModelPrice) => Promise<ModelPrice[]>;
  deletePrice: (provider: CloudProviderId, model: string) => Promise<ModelPrice[]>;
}

// Missing or synchronously failing calls become rejections (tests mock only part of the API).
const attempt = <T,>(fn: () => Promise<T>): Promise<T> => Promise.resolve().then(fn);

export function createCloudStore(): CloudStore {
  let state: CloudState = { keyring: null, providers: null, prices: null, loadError: null, models: {} };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<CloudState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const replaceProvider = (info: ProviderInfo) => {
    set({ providers: (state.providers ?? []).map((p) => (p.id === info.id ? info : p)) });
  };
  const setModels = (provider: CloudProviderId, value: ProviderModelsState) =>
    set({ models: { ...state.models, [provider]: value } });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async reload() {
      const [keyring, providers, prices] = await Promise.allSettled([
        attempt(() => api.getKeyringStatus()),
        attempt(() => api.listProviders()),
        attempt(() => api.listPrices()),
      ]);
      const failed = [keyring, providers, prices].find((r) => r.status === "rejected");
      set({
        keyring: keyring.status === "fulfilled" ? keyring.value : state.keyring,
        providers: providers.status === "fulfilled" ? providers.value : state.providers,
        prices: prices.status === "fulfilled" ? prices.value : state.prices,
        loadError: failed ? toAppError((failed as PromiseRejectedResult).reason) : null,
      });
    },
    async setKey(provider, key) {
      try {
        const info = await attempt(() => api.setApiKey(provider, key));
        replaceProvider(info);
        return info;
      } catch (err) {
        throw toAppError(err);
      }
    },
    async deleteKey(provider) {
      try {
        const info = await attempt(() => api.deleteApiKey(provider));
        replaceProvider(info);
        const { [provider]: _dropped, ...rest } = state.models;
        set({ models: rest });
        return info;
      } catch (err) {
        throw toAppError(err);
      }
    },
    async loadModels(provider) {
      setModels(provider, { loading: true, result: state.models[provider]?.result ?? null, error: null });
      try {
        const result = await attempt(() => api.listProviderModels(provider));
        setModels(provider, { loading: false, result, error: null });
      } catch (err) {
        setModels(provider, { loading: false, result: null, error: toAppError(err) });
      }
    },
    async setPrice(price) {
      try {
        const prices = await attempt(() => api.setPrice(price));
        set({ prices });
        return prices;
      } catch (err) {
        throw toAppError(err);
      }
    },
    async deletePrice(provider, model) {
      try {
        const prices = await attempt(() => api.deletePrice(provider, model));
        set({ prices });
        return prices;
      } catch (err) {
        throw toAppError(err);
      }
    },
  };
}

const CloudContext = createContext<CloudStore | null>(null);

/** Shares provider state (keys, loaded model lists, prices) between Settings, Projects and Chat. */
export function CloudStoreProvider({ children }: { children: ReactNode }) {
  const parent = useContext(CloudContext);
  const [store] = useState(() => parent ?? createCloudStore());
  // Nested providers reuse the outer store (views wrap themselves so they also work standalone).
  if (parent) return <>{children}</>;
  return <CloudContext.Provider value={store}>{children}</CloudContext.Provider>;
}

export interface Cloud extends CloudState {
  store: CloudStore;
}

/** Cloud state; components rendered outside a provider (tests) get their own store. */
export function useCloud(): Cloud {
  const shared = useContext(CloudContext);
  const [own] = useState(() => (shared ? null : createCloudStore()));
  const store = shared ?? own!;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => {
    void store.reload();
  }, [store]);
  return { ...state, store };
}

export function providerInfo(cloud: CloudState, id: CloudProviderId): ProviderInfo | null {
  return cloud.providers?.find((p) => p.id === id) ?? null;
}

export function priceFor(cloud: CloudState, ref: ModelRef): ModelPrice | null {
  return cloud.prices?.find((p) => p.provider === ref.provider && p.model === ref.model) ?? null;
}

/**
 * Cloud models Localis knows of without contacting anyone: lists loaded in this session,
 * models with a price, and the models already in the settings (`extra`).
 */
export function knownCloudModels(
  cloud: CloudState,
  purpose: "chat" | "embedding",
  extra: (ModelRef | null)[] = [],
): ModelRef[] {
  const out: ModelRef[] = [];
  const add = (ref: ModelRef) => {
    if (ref.provider !== "lmstudio" && !out.some((r) => sameRef(r, ref))) out.push(ref);
  };
  const supports = (id: CloudProviderId) => {
    const info = providerInfo(cloud, id);
    if (!info) return true;
    return purpose === "chat" ? info.supportsChat : info.supportsEmbeddings;
  };
  const fits = (m: ModelInfo) => (purpose === "chat" ? isChatKind(m) : isEmbeddingKind(m));
  for (const p of cloud.providers ?? []) {
    if (!supports(p.id)) continue;
    for (const m of cloud.models[p.id]?.result?.models ?? []) if (fits(m)) add({ provider: p.id, model: m.id });
  }
  for (const price of cloud.prices ?? []) {
    if (!supports(price.provider)) continue;
    const listed = cloud.models[price.provider]?.result?.models.find((m) => m.id === price.model);
    if (!listed || fits(listed)) add({ provider: price.provider, model: price.model });
  }
  for (const ref of extra) if (ref) add(ref);
  return out;
}
