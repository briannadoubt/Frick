import { readFileSync } from "node:fs";
import { WorkspaceShell } from "@frick/design-web";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

describe("web workspace shell integration", () => {
  test("renders workspace shell slots for the chat demo layout", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[
          { id: "chat", label: "Chat", icon: "message" },
          { id: "files", label: "Files", icon: "paperclip", disabled: true, badge: "Soon" },
        ]}
        selectedDestination="chat"
        onDestinationChange={() => undefined}
        collection={<div>Threads</div>}
        header={<div>Header area</div>}
        footer={<div>Composer area</div>}
        inspector={<div>Signals</div>}
        inspectorOpen
        navigationLabel={<strong>Frick</strong>}
        navigationActions={<button type="button">Account</button>}
        compactCollectionVisible
      >
        <div>Messages</div>
      </WorkspaceShell>,
    );

    expect(html).toContain("frick-workspace-shell");
    expect(html).toContain('aria-label="Workspace destinations"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Chat");
    expect(html).toContain("Files");
    expect(html).toContain("Threads");
    expect(html).toContain("Messages");
    expect(html).toContain("Signals");
    expect(html).toContain("Composer area");
    expect(html).toContain("frick-workspace-shell__navigation-actions");
    expect(html).toContain('data-compact-collection-visible="true"');
    expect(html).toContain("Soon");
  });

  test("keeps the chat sidebar static while thread rows scroll independently", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(css).toContain(".side-panel {\n  display: flex;");
    expect(css).toContain("flex-direction: column;");
    expect(css).toContain(".inbox-list {\n  align-content: start;");
    expect(css).toContain("overflow-y: auto;");
    expect(css).toContain(".inbox-row {\n  align-items: center;");
    expect(css).toContain("min-height: 0;");
    expect(css).toContain(".compact-nav-action {\n  align-items: center;");
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain("display: inline-flex;");
  });
});
