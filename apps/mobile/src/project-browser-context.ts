import { createContext } from "react";
export const ProjectBrowseContext = createContext<(() => void) | undefined>(undefined);
