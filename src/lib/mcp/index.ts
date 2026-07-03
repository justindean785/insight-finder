import { auth, defineMcp } from "@lovable.dev/mcp-js";
import echoTool from "./tools/echo";
import listInvestigationsTool from "./tools/list-investigations";
import getInvestigationTool from "./tools/get-investigation";

// Build the OAuth issuer from the Supabase project ref only. VITE inlines this
// literal at build time so the entry stays import-safe (no runtime env read).
// The direct supabase.co host is required — mcp-js validates the token issuer
// against the discovery document, which publishes the direct form.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "swarmbot-mcp",
  title: "Swarmbot OSINT",
  version: "0.1.0",
  instructions:
    "Tools for the Swarmbot OSINT investigator. Use `echo` to verify connectivity, " +
    "`list_investigations` to see the analyst's recent investigation threads, and " +
    "`get_investigation` to pull a full thread with its messages and artifacts.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [echoTool, listInvestigationsTool, getInvestigationTool],
});