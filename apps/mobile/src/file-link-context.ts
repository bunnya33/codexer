import { createContext, useContext } from "react";

export const FileLinkContext = createContext<((path: string) => void) | undefined>(undefined);
export const useFileLink = () => useContext(FileLinkContext);
