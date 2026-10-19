import { createContext, useContext } from "react";

export type ShellApi = { openNav: () => void };

export const ShellContext = createContext<ShellApi>({ openNav: () => {} });

/** The enclosing AppShell's controls (the phone cases drawer). */
export function useShell(): ShellApi {
  return useContext(ShellContext);
}
