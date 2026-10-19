/** The six sections of a case, as the workspace tab strip names them. */
export type WorkspaceTab = "overview" | "chat" | "evidence" | "report" | "graph" | "tools";

/** The read-only case viewer (`/cases/:id`): no live investigation, so no
 *  Overview or Investigate. Report leads — it is what the viewer is for. */
export const CASE_VIEW_SECTIONS: readonly WorkspaceTab[] = ["report", "evidence", "tools", "graph"];
