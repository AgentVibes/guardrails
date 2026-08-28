// BAD: the whole context channel D1 removes — provider, hook, null-check.
import { createContext, useContext } from "react";

type RootStore = { readonly ready: boolean };

export const StoreContext = createContext<RootStore | null>(null);

export const useStore = (): RootStore => {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("StoreProvider missing");
  return store;
};

export function readReady(): boolean {
  return useStore().ready;
}
