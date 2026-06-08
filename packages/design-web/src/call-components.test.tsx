import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CallButton, CallControlBar } from "./index.js";

/**
 * FR-84 — web call surface (FrickCallButton family + in-call control bar).
 * Asserts the tokenized semantic classes, accessible names, and pressed-state
 * reflection. The control bar's styling lives entirely in tokenized CSS — these
 * tests pin the class/attribute contract that CSS targets.
 */

const componentsCss = readFileSync(
  fileURLToPath(new URL("./components.css", import.meta.url)),
  "utf8",
);

describe("FR-84 — CallButton", () => {
  test("start mode renders a primary, pill call button with an accessible name", () => {
    const html = renderToStaticMarkup(<CallButton mode="start" />);
    expect(html).toContain("frick-call-button");
    expect(html).toContain("frick-call-button--start");
    expect(html).toContain("frick-button--primary");
    expect(html).toContain('data-call-mode="start"');
    expect(html).toContain('aria-label="Start call"');
  });

  test("end mode uses the danger tone and end label", () => {
    const html = renderToStaticMarkup(<CallButton mode="end" />);
    expect(html).toContain("frick-call-button--end");
    expect(html).toContain("frick-button--danger");
    expect(html).toContain('aria-label="End call"');
  });

  test("children replace the visually-hidden label", () => {
    const html = renderToStaticMarkup(<CallButton>Call Ada</CallButton>);
    expect(html).toContain("Call Ada");
    expect(html).not.toContain('aria-label="Start call"');
  });
});

describe("FR-84 — CallControlBar", () => {
  test("renders mic/camera/screen toggles reflecting active state", () => {
    const html = renderToStaticMarkup(
      <CallControlBar micEnabled cameraEnabled={false} screenSharing={false} onLeave={() => {}} />,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Call controls"');
    // mic on → pressed/active, camera off → not pressed.
    expect(html).toContain('aria-label="Mute microphone"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Turn camera on"');
    expect(html).toContain('aria-pressed="false"');
    // leave action present.
    expect(html).toContain('aria-label="Leave call"');
  });

  test("control styling is fully tokenized (no raw color literals)", () => {
    // The new call classes must exist and reference design tokens only.
    expect(componentsCss).toContain(".frick-call-button--end");
    expect(componentsCss).toContain(".frick-call-controls");
    expect(componentsCss).toContain('.frick-call-controls__toggle[data-active="true"]');
    const callBlock = componentsCss.slice(componentsCss.indexOf(".frick-call-button"));
    const callRules = callBlock.slice(0, callBlock.indexOf(".frick-data-table"));
    // No hex / rgb literals in the call rules — colors come from var(--frick-*).
    expect(callRules).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(callRules).not.toMatch(/\brgb\(/);
    expect(callRules).toContain("var(--frick-color-danger)");
  });
});
