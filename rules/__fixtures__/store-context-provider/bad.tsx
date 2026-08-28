// BAD: provider + hook, the shape every store-bearing app in the park still has.
import { createContext, useContext } from "react";

type RootStore = { readonly ready: boolean };

const StoreContext = createContext<RootStore | null>(null);

export function useStore(): RootStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("StoreProvider missing");
  return store;
}

export function App(props: { readonly store: RootStore }) {
  return (
    <StoreContext.Provider value={props.store}>
      <ReadyBadge />
    </StoreContext.Provider>
  );
}

function ReadyBadge() {
  return <span>{String(useStore().ready)}</span>;
}
