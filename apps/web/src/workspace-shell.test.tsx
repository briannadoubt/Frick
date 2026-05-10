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
    expect(html).toContain("Soon");
  });
});
