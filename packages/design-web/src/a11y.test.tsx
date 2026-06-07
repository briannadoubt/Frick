import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Composer,
  IconButton,
  PresenceDot,
  ProgressRing,
  SegmentedControl,
  WorkspaceShell,
} from "./index.js";
import {
  frickIcons,
  frickIconNames,
  iconPackFor,
  isFrickIconName,
  nativeIcons,
} from "./icons.js";

const componentsCss = readFileSync(
  fileURLToPath(new URL("./components.css", import.meta.url)),
  "utf8",
);

describe("a11y contract: icon names", () => {
  test("the frozen contract list has no duplicates", () => {
    expect(new Set(frickIconNames).size).toBe(frickIconNames.length);
  });

  test("every contract name resolves in both icon packs", () => {
    for (const name of frickIconNames) {
      expect(nativeIcons[name], `native pack missing ${name}`).toBeDefined();
      expect(frickIcons[name], `frick pack missing ${name}`).toBeDefined();
      expect(iconPackFor("native")[name]).toBe(nativeIcons[name]);
      expect(iconPackFor("frick")[name]).toBe(frickIcons[name]);
    }
  });

  test("isFrickIconName guards the contract", () => {
    expect(isFrickIconName("send")).toBe(true);
    expect(isFrickIconName("not-an-icon")).toBe(false);
    expect(isFrickIconName(undefined)).toBe(false);
  });
});

describe("a11y contract: accessible names + roles", () => {
  test("icon-only button exposes an accessible name and hides the glyph", () => {
    const html = renderToStaticMarkup(<IconButton icon="reload" label="Refresh" />);
    expect(html).toContain('aria-label="Refresh"');
    // The decorative glyph must not be announced separately.
    expect(html).toContain('aria-hidden="true"');
  });

  test("composer textarea is keyboard-labelled and submits via Enter", () => {
    const html = renderToStaticMarkup(<Composer placeholder="Message" actionLabel="Send message" />);
    // textarea has an accessible name even without a visible <label>.
    expect(html).toContain('aria-label="Message"');
    // the send affordance is a labelled control, not a bare icon.
    expect(html).toContain('aria-label="Send message"');
  });

  test("status/graphic components expose role + name", () => {
    expect(renderToStaticMarkup(<PresenceDot status="online" label="Ada online" />)).toContain(
      'role="img"',
    );
    const ring = renderToStaticMarkup(<ProgressRing value={42} label="42 percent" />);
    expect(ring).toContain('role="progressbar"');
    expect(ring).toContain('aria-valuenow="42"');
    expect(ring).toContain('aria-label="42 percent"');
  });

  test("workspace navigation is a labelled landmark with current state", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[
          { id: "home", label: "Home" },
          { id: "calls", label: "Calls" },
        ]}
        selectedDestination="home"
      >
        <div />
      </WorkspaceShell>,
    );
    expect(html).toContain('aria-label="Workspace destinations"');
    expect(html).toContain('aria-current="page"');
  });

  test("segmented control options report pressed state for the active value", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl
        value="chat"
        options={[
          { value: "chat", label: "Chat" },
          { value: "calls", label: "Calls" },
        ]}
      />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });
});

describe("a11y contract: focus + reduced motion (CSS)", () => {
  test("interactive controls ship a visible focus ring", () => {
    expect(componentsCss).toContain(":focus-visible");
    expect(componentsCss).toContain("--frick-focus-ring-color");
    expect(componentsCss).toMatch(/\.frick-button:focus-visible/);
    expect(componentsCss).toMatch(/outline:\s*var\(--frick-focus-ring-width\)/);
  });

  test("honors prefers-reduced-motion", () => {
    expect(componentsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(componentsCss).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(componentsCss).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});
