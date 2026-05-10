import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Badge,
  Button,
  ChatBubble,
  Composer,
  FrickDesignProvider,
  IconButton,
  PresenceDot,
  SegmentedControl,
  Stack,
  Text,
  TextField,
  WorkspaceShell,
  WorkspaceListItem,
  useFrickDesign,
} from "./index.js";

function ContextProbe() {
  const design = useFrickDesign();
  return <span data-mode={design.mode} data-density={design.density} data-brand={design.brand} />;
}

describe("Frick design web components", () => {
  test("server-renders provider context and runtime attributes", () => {
    const html = renderToStaticMarkup(
      <FrickDesignProvider mode="dark" density="compact" brand="studio">
        <ContextProbe />
      </FrickDesignProvider>,
    );

    expect(html).toContain('data-frick-mode="dark"');
    expect(html).toContain('data-frick-density="compact"');
    expect(html).toContain('data-frick-brand="studio"');
    expect(html).toContain('data-mode="dark"');
  });

  test("renders foundation and control primitives with semantic classes", () => {
    const html = renderToStaticMarkup(
      <Stack gap="md">
        <Text tone="muted">Hello</Text>
        <Button tone="primary" icon="send">
          Send
        </Button>
        <IconButton icon="reload" label="Refresh" />
        <TextField label="Name" placeholder="Ada" error="Required" />
        <SegmentedControl
          label="Mode"
          value="chat"
          options={[
            { value: "chat", label: "Chat" },
            { value: "calls", label: "Calls" },
          ]}
        />
      </Stack>,
    );

    expect(html).toContain("frick-stack");
    expect(html).toContain("frick-button");
    expect(html).toContain("frick-icon-button");
    expect(html).toContain("aria-label=\"Refresh\"");
    expect(html).toContain("frick-field__error");
    expect(html).toContain("aria-pressed=\"true\"");
  });

  test("renders feedback and communication components for SSR", () => {
    const html = renderToStaticMarkup(
      <>
        <Badge tone="success">Synced</Badge>
        <PresenceDot status="online" label="Ada online" />
        <ChatBubble author="Ada" timestamp="now" variant="outgoing">
          On my way
        </ChatBubble>
        <Composer placeholder="Message" actionLabel="Send message" />
      </>,
    );

    expect(html).toContain("frick-badge");
    expect(html).toContain("data-status=\"online\"");
    expect(html).toContain("frick-chat-bubble");
    expect(html).toContain("Send message");
  });

  test("renders workspace shell semantic navigation slots", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[
          { id: "chat", label: "Chat", icon: "message" },
          { id: "files", label: "Files", icon: "paperclip", disabled: true, badge: "Soon" },
        ]}
        selectedDestination="chat"
        onDestinationChange={() => undefined}
        collection={<div>Threads collection</div>}
        header={<div>Header area</div>}
        footer={<div>Composer area</div>}
        inspector={<div>Inspector area</div>}
        inspectorOpen
        navigationLabel={<strong>Frick</strong>}
        navigationActions={<button type="button">Account</button>}
        compactCollectionVisible
      >
        <div>Primary chat content</div>
      </WorkspaceShell>,
    );

    expect(html).toContain("frick-workspace-shell");
    expect(html).toContain('aria-label="Workspace destinations"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Threads collection");
    expect(html).toContain("Primary chat content");
    expect(html).toContain("Inspector area");
    expect(html).toContain("Composer area");
    expect(html).toContain("frick-workspace-shell__brand");
    expect(html).toContain("frick-workspace-shell__navigation-actions");
    expect(html).toContain('data-compact-collection-visible="true"');
    expect(html).toContain("Frick");
    expect(html).toContain("Account");
    expect(html).toContain("Soon");
  });

  test("renders workspace list items from the component library", () => {
    const html = renderToStaticMarkup(
      <WorkspaceListItem
        title="Foundation General"
        subtitle="Latest synced message"
        meta="Read #4 / Last #5"
        badge="1"
        selected
      />,
    );

    expect(html).toContain("frick-workspace-list-item");
    expect(html).toContain('data-selected="true"');
    expect(html).toContain("Foundation General");
    expect(html).toContain("Latest synced message");
    expect(html).toContain("Read #4 / Last #5");
    expect(html).toContain("1");
  });

  test("renders workspace shell content-only layout without optional slots", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell destinations={[{ id: "chat", label: "Chat" }]} selectedDestination="chat">
        <div>Primary only</div>
      </WorkspaceShell>,
    );

    expect(html).toContain('data-has-collection="false"');
    expect(html).toContain('data-has-inspector="false"');
    expect(html).toContain("Primary only");
    expect(html).not.toContain("frick-workspace-shell__collection");
    expect(html).not.toContain("frick-workspace-shell__header");
    expect(html).not.toContain("frick-workspace-shell__footer");
    expect(html).not.toContain("frick-workspace-shell__inspector");
  });

  test("renders closed workspace shell inspector without reserving an inspector slot", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[{ id: "chat", label: "Chat" }]}
        selectedDestination="chat"
        collection={<div>Threads collection</div>}
        inspector={<div>Inspector area</div>}
        inspectorOpen={false}
      >
        <div>Primary chat content</div>
      </WorkspaceShell>,
    );

    expect(html).toContain('data-has-collection="true"');
    expect(html).toContain('data-has-inspector="false"');
    expect(html).toContain('data-open="false"');
    expect(html).toContain("Inspector area");
    expect(html).toContain("Threads collection");
    expect(html).toContain("Primary chat content");
  });

  test("keeps the web collection sidebar until genuinely compact widths", () => {
    const css = readFileSync(new URL("./components.css", import.meta.url), "utf8");

    expect(css).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(css).toContain("block-size: 100dvh");
    expect(css).toContain("frick-workspace-shell__destination-list");
    expect(css).toContain("frick-workspace-shell__navigation-actions");
    expect(css).toContain("@media (min-width: 641px)");
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toContain('data-compact-collection-visible="false"');
    expect(css).toContain('data-compact-collection-visible="true"');
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr)");
    expect(css).not.toContain("grid-row: 2");
    expect(css).not.toContain("position: fixed");
  });
});
