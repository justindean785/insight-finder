import { createContext, useContext } from "react";
import type { NextStepItem } from "@/components/pivots/NextSteps";
export interface CasePivotQueue {
  status: "loading" | "ready" | "error";
  items: NextStepItem[];
  count: number;
  refresh: () => Promise<void>;
}
export const CasePivotQueueContext = createContext<CasePivotQueue | null>(null);
export const useCasePivotQueue = () => useContext(CasePivotQueueContext);
