import { AsyncLocalStorage } from "node:async_hooks";

// Set only after transport authentication. Tool arguments cannot supply identity.
export const requestPrincipal = new AsyncLocalStorage<string>();
