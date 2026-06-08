import { readFileSync } from "node:fs";
import { WorkspaceShell } from "@fricken/design-web";
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

  test("renders the chat demo destination set: Chat active + Files/Calls/Admin placeholders", () => {
    // Mirrors the `workspaceDestinations` the chat demo (apps/web/src/App.tsx)
    // hands the shell after the FR-89 cutover: Chat is enabled + selected, the
    // other three are visible-but-disabled "Soon" placeholders.
    const demoDestinations = [
      { id: "chat", label: "Chat", icon: "message" as const },
      { id: "files", label: "Files", icon: "paperclip" as const, disabled: true, badge: "Soon" },
      { id: "calls", label: "Calls", icon: "video" as const, disabled: true, badge: "Soon" },
      { id: "admin", label: "Admin", icon: "settings" as const, disabled: true, badge: "Soon" },
    ];

    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={demoDestinations}
        selectedDestination="chat"
        onDestinationChange={() => undefined}
        collection={<div>Threads</div>}
      >
        <div>Messages</div>
      </WorkspaceShell>,
    );

    // All four destinations are visible in the navigation.
    for (const label of ["Chat", "Files", "Calls", "Admin"]) {
      expect(html).toContain(label);
    }
    // Chat is the selected/active destination.
    expect(html).toContain('aria-current="page"');
    // The three placeholder destinations are rendered but not interactive.
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // ...and badged "Soon" so the placeholder status is honest.
    expect(html).toContain("Soon");
  });

  test("keeps the accessible DOM order: destinations, collection, content, inspector", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[{ id: "chat", label: "Chat" }]}
        selectedDestination="chat"
        collection={<div>CollectionSlot</div>}
        inspector={<div>InspectorSlot</div>}
        inspectorOpen
      >
        <div>ContentSlot</div>
      </WorkspaceShell>,
    );

    const navIndex = html.indexOf('aria-label="Workspace destinations"');
    const collectionIndex = html.indexOf("CollectionSlot");
    const contentIndex = html.indexOf("ContentSlot");
    const inspectorIndex = html.indexOf("InspectorSlot");

    expect(navIndex).toBeGreaterThanOrEqual(0);
    expect(navIndex).toBeLessThan(collectionIndex);
    expect(collectionIndex).toBeLessThan(contentIndex);
    expect(contentIndex).toBeLessThan(inspectorIndex);
  });

  test("exposes an accessible close affordance for the inspector", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[{ id: "chat", label: "Chat" }]}
        selectedDestination="chat"
        inspector={<div>Details</div>}
        inspectorOpen
        closeInspectorLabel="Dismiss panel"
      >
        <div>Messages</div>
      </WorkspaceShell>,
    );

    expect(html).toContain('aria-label="Dismiss panel"');
    expect(html).toContain('data-open="true"');
  });

  test("remains usable with no inspector supplied", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[{ id: "chat", label: "Chat" }]}
        selectedDestination="chat"
      >
        <div>Messages</div>
      </WorkspaceShell>,
    );

    expect(html).toContain("frick-workspace-shell");
    expect(html).toContain("Messages");
    expect(html).not.toContain("frick-workspace-shell__inspector");
    expect(html).toContain('data-has-inspector="false"');
  });

  test("ships the responsive breakpoints for compact, tablet, and desktop layouts", () => {
    const css = readFileSync(
      new URL("../../../packages/design-web/src/components.css", import.meta.url),
      "utf8",
    );

    // Compact: bottom destination bar + collection/inspector as drawer surfaces.
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain(
      '.frick-workspace-shell__body[data-has-collection="true"][data-compact-collection-visible="false"] .frick-workspace-shell__collection',
    );
    // Tablet: collection sidebar appears beside content.
    expect(css).toContain("@media (min-width: 641px)");
    // Desktop: rail + sidebar + content + inspector as simultaneous panes.
    expect(css).toContain("@media (min-width: 1041px)");
    expect(css).toContain(
      '.frick-workspace-shell__body[data-has-collection="true"][data-has-inspector="true"]',
    );
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
