import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static integration contract: the real `ChatPage.tsx` wraps the workspace
 * subtree in `WorkspaceUIStateProvider` AS A CHILD of `CaseSnapshotProvider`.
 *
 * The runtime contract this guarantees is that `key={threadId}` on the
 * CaseSnapshotProvider unmounts the UI state too, which the no-cross-case-leak
 * test verifies in isolation. If a future refactor hoists the UI state above
 * the key boundary, OR removes it from the real page entirely, this check
 * fails loudly and the invariant does not drift silently.
 *
 * A full runtime mount of `ChatPage` pulls in `useAuth`, routing, Supabase
 * client, lazy-loaded tab bundles and the realtime subscription — enough
 * side effect that a shallow source assertion is the honest tool here and
 * documents the invariant permanently in the test name.
 */

const CHATPAGE = readFileSync(
  resolve(__dirname, "../pages/ChatPage.tsx"),
  "utf8",
);

describe("ChatPage integration — WorkspaceUIStateProvider is wired inside CaseSnapshotProvider", () => {
  it("imports WorkspaceUIStateProvider", () => {
    expect(CHATPAGE).toMatch(
      /import \{\s*WorkspaceUIStateProvider\s*\} from "@\/components\/workspace\/WorkspaceUIStateProvider"/,
    );
  });

  it("renders WorkspaceUIStateProvider somewhere in the tree", () => {
    expect(CHATPAGE).toMatch(/<WorkspaceUIStateProvider[^>]*>/);
    expect(CHATPAGE).toMatch(/<\/WorkspaceUIStateProvider>/);
  });

  it("renders WorkspaceUIStateProvider INSIDE the CaseSnapshotProvider boundary", () => {
    const caseOpen = CHATPAGE.indexOf("<CaseSnapshotProvider");
    const caseClose = CHATPAGE.indexOf("</CaseSnapshotProvider>");
    const uiOpen = CHATPAGE.indexOf("<WorkspaceUIStateProvider");
    const uiClose = CHATPAGE.indexOf("</WorkspaceUIStateProvider>");

    expect(caseOpen).toBeGreaterThan(-1);
    expect(caseClose).toBeGreaterThan(-1);
    expect(uiOpen).toBeGreaterThan(-1);
    expect(uiClose).toBeGreaterThan(-1);

    // Strict nesting: UI provider opens AFTER case provider opens and
    // closes BEFORE case provider closes. If the UI provider were hoisted
    // above, the key={threadId} boundary would stop clearing drafts/
    // selection on case switch — exactly the cross-case leak the shape
    // defends against.
    expect(uiOpen).toBeGreaterThan(caseOpen);
    expect(uiClose).toBeLessThan(caseClose);
  });

  it("CaseSnapshotProvider is keyed by threadId (parent clears unmounts the UI state too)", () => {
    expect(CHATPAGE).toMatch(/<CaseSnapshotProvider[^>]*\bkey=\{threadId\}/);
  });

  it("Workbench is reached through the UI provider boundary (so it can read selection)", () => {
    // ChatPage wraps providers around a child component (currently
    // `<ChatWorkspace .../>`). The Workbench renders inside that child, not
    // in the top-level return. The invariant is that the component mounted
    // between the provider open/close tags eventually renders the Workbench.
    const uiOpen = CHATPAGE.indexOf("<WorkspaceUIStateProvider");
    const uiClose = CHATPAGE.indexOf("</WorkspaceUIStateProvider>");
    const inside = CHATPAGE.slice(uiOpen, uiClose);
    // The inner child receives threadId (and typically userId) so it can mount
    // the workspace. Capture its component name; it must be a JSX element and
    // non-empty.
    const childMatch = inside.match(/<([A-Z][A-Za-z0-9_]*)\b[^>]*threadId=\{threadId\}/);
    expect(childMatch, "the UI provider must render a child that receives threadId").not.toBeNull();
    const childName = childMatch![1];

    // That child component must mount the Workbench somewhere in its body.
    const childDefRe = new RegExp(`function\\s+${childName}\\b[\\s\\S]*?<Workbench\\b`);
    expect(
      childDefRe.test(CHATPAGE),
      `${childName} is the UI provider's child and must mount <Workbench>`,
    ).toBe(true);
  });
});
