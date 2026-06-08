/**
 * Cross-cutting accessibility suite for @fricken/design-web (FR-104).
 *
 * Where `a11y.test.tsx` spot-checks individual components, this suite locks in
 * the *contract* shipped in FR-101 as a set of invariants that scale with the
 * component/icon surface: interactive controls are real, keyboard-operable
 * elements with managed/visible focus and accessible names/roles; the icon-name
 * contract is complete and resolves in every pack; and the CSS honors
 * reduced-motion and gives every interactive selector a focus ring. The intent
 * is that adding a control or icon without wiring its a11y affordances trips a
 * test here rather than shipping a regression.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import {
  Button,
  Composer,
  IconButton,
  PresenceDot,
  ProgressRing,
  SegmentedControl,
  TextArea,
  TextField,
  Toggle,
  WorkspaceListItem,
  WorkspaceShell,
} from "./index.js";
import {
  frickIconNames,
  frickIcons,
  icons,
  iconPackFor,
  isFrickIconName,
  nativeIcons,
  semanticIcons,
} from "./icons.js";

const componentsCss = readFileSync(
  fileURLToPath(new URL("./components.css", import.meta.url)),
  "utf8",
);

/** Read the tag name of the rendered root element. */
function rootTag(html: string): string {
  const match = html.match(/^<([a-z0-9-]+)/i);
  return match?.[1] ?? "";
}

describe("a11y suite: icon-name contract is complete and resolves", () => {
  test("the contract is non-empty and frozen against duplicates", () => {
    expect(frickIconNames.length).toBeGreaterThan(0);
    expect(new Set(frickIconNames).size).toBe(frickIconNames.length);
  });

  test("every contract name resolves to a component in BOTH packs", () => {
    // Native glyphs are lucide forwardRef objects; frick fallbacks are function
    // components. Both are valid React component types, so assert "defined and
    // renderable" rather than a specific JS typeof.
    for (const name of frickIconNames) {
      expect(nativeIcons[name], `native pack missing ${name}`).toBeDefined();
      expect(frickIcons[name], `frick pack missing ${name}`).toBeDefined();
      expect(typeof frickIcons[name], `frick fallback ${name} not a component fn`).toBe("function");
    }
  });

  test("the two packs cover exactly the contract — no extra or missing keys", () => {
    const contract = [...frickIconNames].sort();
    expect(Object.keys(nativeIcons).sort()).toEqual(contract);
    expect(Object.keys(frickIcons).sort()).toEqual(contract);
  });

  test("iconPackFor selects the matching pack and semanticIcons aliases native", () => {
    expect(iconPackFor("native")).toBe(nativeIcons);
    expect(iconPackFor("frick")).toBe(frickIcons);
    expect(semanticIcons).toBe(nativeIcons);
  });

  test("every glyph in the native pack is reachable from the icons registry", () => {
    // Flatten the categorized registry to the set of glyph components in use.
    const registryGlyphs = new Set<unknown>(
      Object.values(icons).flatMap((group) => Object.values(group)),
    );
    // Native-pack glyphs come from the registry (plus Sun/Moon themes); the
    // registry is the source of truth for the lucide-backed glyphs.
    for (const name of frickIconNames) {
      const glyph = nativeIcons[name];
      const inRegistry = registryGlyphs.has(glyph);
      const isTheme = name === "themeLight" || name === "themeDark";
      expect(inRegistry || isTheme, `${name} glyph not sourced from registry`).toBe(true);
    }
  });

  test("isFrickIconName guards exactly the contract", () => {
    for (const name of frickIconNames) {
      expect(isFrickIconName(name)).toBe(true);
    }
    expect(isFrickIconName("not-an-icon")).toBe(false);
    expect(isFrickIconName(undefined)).toBe(false);
    expect(isFrickIconName(42)).toBe(false);
  });

  test("rendered glyphs are decorative (aria-hidden, not focusable)", () => {
    for (const name of frickIconNames) {
      const html = renderToStaticMarkup(<IconButton icon={name} label={name} />);
      expect(html, `${name} glyph not aria-hidden`).toContain('aria-hidden="true"');
      expect(html, `${name} glyph focusable`).toContain('focusable="false"');
    }
  });
});

describe("a11y suite: interactive controls are real, keyboard-operable elements", () => {
  // Each entry asserts the control renders as a native focusable element (so it
  // sits in the tab order and is operable by keyboard) and carries an
  // accessible name.
  const cases: Array<{ name: string; el: ReactElement; tag: string; namePattern: RegExp }> = [
    { name: "Button", el: <Button>Save</Button>, tag: "button", namePattern: />Save</ },
    {
      name: "IconButton",
      el: <IconButton icon="send" label="Send message" />,
      tag: "button",
      namePattern: /aria-label="Send message"/,
    },
    {
      name: "TextField",
      el: <TextField label="Email" />,
      tag: "div",
      namePattern: /<input[^>]*id="frick-field-email"/,
    },
    {
      name: "TextArea",
      el: <TextArea label="Bio" />,
      tag: "div",
      namePattern: /<textarea[^>]*id="frick-area-bio"/,
    },
    {
      name: "Toggle",
      el: <Toggle label="Notifications" />,
      tag: "label",
      namePattern: /<input[^>]*type="checkbox"/,
    },
  ];

  for (const { name, el, tag, namePattern } of cases) {
    test(`${name} renders a native ${tag} with an accessible name`, () => {
      const html = renderToStaticMarkup(el);
      expect(rootTag(html), `${name} root element`).toBe(tag);
      expect(html, `${name} accessible name`).toMatch(namePattern);
    });
  }

  test("Button/IconButton default to type=button so they never submit a form by accident", () => {
    expect(renderToStaticMarkup(<Button>Go</Button>)).toContain('type="button"');
    expect(renderToStaticMarkup(<IconButton icon="add" label="Add" />)).toContain('type="button"');
  });

  test("TextField label is wired to its input via htmlFor/id", () => {
    const html = renderToStaticMarkup(<TextField label="Email" />);
    expect(html).toContain('for="frick-field-email"');
    expect(html).toContain('id="frick-field-email"');
  });

  test("error state is announced via aria-invalid", () => {
    expect(renderToStaticMarkup(<TextField label="Email" error="Required" />)).toContain(
      'aria-invalid="true"',
    );
    expect(renderToStaticMarkup(<TextArea label="Bio" error="Required" />)).toContain(
      'aria-invalid="true"',
    );
  });

  test("SegmentedControl options are buttons that report pressed state", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl
        value="chat"
        options={[
          { value: "chat", label: "Chat" },
          { value: "calls", label: "Calls" },
        ]}
      />,
    );
    expect((html.match(/<button/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  test("Composer textarea is labelled and the send affordance is a labelled control", () => {
    const html = renderToStaticMarkup(<Composer placeholder="Message" actionLabel="Send" />);
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain('aria-label="Send"');
    // submitOnEnter is the default; the handler is wired on the textarea.
    expect(html).toMatch(/<textarea[^>]*class="frick-composer__input"/);
  });

  test("WorkspaceListItem renders an actionable button with selected state", () => {
    const html = renderToStaticMarkup(
      <WorkspaceListItem title="Ada" selected onClick={() => {}} />,
    );
    expect(rootTag(html)).toBe("button");
    expect(html).toContain('data-selected="true"');
  });

  test("workspace navigation is a labelled landmark exposing current + disabled state", () => {
    const html = renderToStaticMarkup(
      <WorkspaceShell
        destinations={[
          { id: "home", label: "Home" },
          { id: "calls", label: "Calls", disabled: true },
        ]}
        selectedDestination="home"
      >
        <div />
      </WorkspaceShell>,
    );
    expect(html).toContain('aria-label="Workspace destinations"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("disabled");
  });
});

describe("a11y suite: graphical/status components expose role + accessible name", () => {
  test("PresenceDot is an img with a name", () => {
    const html = renderToStaticMarkup(<PresenceDot status="online" label="Ada online" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ada online"');
  });

  test("ProgressRing is a progressbar with bounded value semantics", () => {
    const html = renderToStaticMarkup(<ProgressRing value={42} label="42 percent" />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-label="42 percent"');
  });

  test("ProgressRing clamps out-of-range values into [0,100]", () => {
    expect(renderToStaticMarkup(<ProgressRing value={150} label="x" />)).toContain(
      'aria-valuenow="100"',
    );
    expect(renderToStaticMarkup(<ProgressRing value={-5} label="x" />)).toContain(
      'aria-valuenow="0"',
    );
  });
});

describe("a11y suite: visible focus + reduced motion (CSS contract)", () => {
  // The interactive selectors that MUST carry a visible focus ring. Adding an
  // interactive control means adding it to the focus-visible block; this list
  // keeps that contract honest.
  const focusableSelectors = [
    ".frick-button",
    ".frick-icon-button",
    ".frick-segmented__option",
    ".frick-workspace-shell__destination",
    ".frick-workspace-list-item",
    ".frick-input",
    ".frick-textarea",
    ".frick-composer__input",
  ];

  test("focus-ring tokens are defined", () => {
    expect(componentsCss).toContain("--frick-focus-ring-width");
    expect(componentsCss).toContain("--frick-focus-ring-offset");
    expect(componentsCss).toContain("--frick-focus-ring-color");
  });

  test("every interactive selector has a :focus-visible ring", () => {
    // Isolate the focus-visible rule region to assert membership precisely.
    const block = componentsCss.slice(componentsCss.indexOf(":focus-visible"));
    for (const selector of focusableSelectors) {
      expect(block, `${selector} missing :focus-visible ring`).toContain(
        `${selector}:focus-visible`,
      );
    }
    expect(componentsCss).toMatch(/outline:\s*var\(--frick-focus-ring-width\)/);
    expect(componentsCss).toMatch(/outline-offset:\s*var\(--frick-focus-ring-offset\)/);
  });

  test("the UA default focus is suppressed for pointer (non-keyboard) focus", () => {
    expect(componentsCss).toMatch(/:focus:not\(:focus-visible\)/);
  });

  test("prefers-reduced-motion neutralizes transitions and animations", () => {
    expect(componentsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(componentsCss).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(componentsCss).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});
