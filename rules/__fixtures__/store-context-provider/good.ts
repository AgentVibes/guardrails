// GOOD: one module-level store, dependencies injected once from the entry file.
type RootStore = { readonly ready: boolean };

let instance: RootStore | undefined;

export function initRootStore(deps: RootStore): void {
  instance = deps;
}

export function getRootStore(): RootStore {
  if (instance === undefined) throw new Error("initRootStore() has not run yet");
  return instance;
}
