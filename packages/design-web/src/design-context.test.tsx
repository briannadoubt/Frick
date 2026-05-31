import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FrickDesignProvider,
  IconButton,
  dataAttributesFor,
  defaultFrickDesignAxes,
  frickIcons,
  iconPackFor,
  mergeDesignAxes,
  nativeIcons,
  useDesignContext,
  useFrickDesign,
  type FrickDesignAxes,
  type FrickDesignRuntime,
} from "./index.js";
import { frickTokens } from "./generated/tokens.js";

function ContextProbe({ onRead }: { onRead: (ctx: FrickDesignRuntime) => void }) {
  const ctx = useDesignContext();
  onRead(ctx);
  return (
    <span
      data-mode={ctx.mode}
      data-density={ctx.density}
      data-brand={ctx.brand}
      data-icon-pack={ctx.iconPack}
    />
  );
}

describe("runtime design context — defaults", () => {
  test("default context matches today's generated defaults", () => {
    expect(defaultFrickDesignAxes).toEqual({
      mode: "light",
      density: "regular",
      brand: "frick",
      iconPack: "native",
    });
    // The generated web token artifact (`pnpm design:generate`) is resolved with
    // exactly these options — the runtime default must not drift from it.
    expect(frickTokens.options.mode).toBe(defaultFrickDesignAxes.mode);
    expect(frickTokens.options.density).toBe(defaultFrickDesignAxes.density);
    expect(frickTokens.options.brand).toBe(defaultFrickDesignAxes.brand);
    expect(frickTokens.options.iconPack).toBe(defaultFrickDesignAxes.iconPack);
  });

  test("provider with no props exposes the default context", () => {
    let ctx: FrickDesignRuntime | undefined;
    renderToStaticMarkup(
      <FrickDesignProvider>
        <ContextProbe onRead={(value) => (ctx = value)} />
      </FrickDesignProvider>,
    );
    expect(ctx?.mode).toBe("light");
    expect(ctx?.density).toBe("regular");
    expect(ctx?.brand).toBe("frick");
    expect(ctx?.iconPack).toBe("native");
  });

  test("default provider applies the :root-matching data attributes", () => {
    const html = renderToStaticMarkup(
      <FrickDesignProvider>
        <span />
      </FrickDesignProvider>,
    );
    expect(html).toContain('data-frick-mode="light"');
    expect(html).toContain('data-frick-density="regular"');
    expect(html).toContain('data-frick-brand="frick"');
    expect(html).toContain('data-frick-icon-pack="native"');
  });
});

describe("runtime design context — each axis updates resolved selection", () => {
  const cases: Array<{ axis: keyof FrickDesignAxes; value: string; attr: keyof ReturnType<typeof dataAttributesFor> }> = [
    { axis: "mode", value: "dark", attr: "data-frick-mode" },
    { axis: "density", value: "compact", attr: "data-frick-density" },
    { axis: "brand", value: "frickenChat", attr: "data-frick-brand" },
    { axis: "iconPack", value: "frick", attr: "data-frick-icon-pack" },
  ];

  for (const { axis, value, attr } of cases) {
    test(`changing ${axis} updates the applied token selector and exposed context`, () => {
      let ctx: FrickDesignRuntime | undefined;
      const html = renderToStaticMarkup(
        <FrickDesignProvider {...{ [axis]: value }}>
          <ContextProbe onRead={(value2) => (ctx = value2)} />
        </FrickDesignProvider>,
      );
      // The data attribute is what selects the resolved CSS-variable block in
      // tokens.css at runtime — changing it re-resolves every token live.
      expect(html).toContain(`${attr}="${value}"`);
      expect(ctx?.[axis]).toBe(value);
      expect(ctx?.dataAttributes[attr]).toBe(value);
    });
  }

  test("custom brand and icon pack values pass through to the selector", () => {
    const html = renderToStaticMarkup(
      <FrickDesignProvider brand="studio" iconPack="custom">
        <span />
      </FrickDesignProvider>,
    );
    expect(html).toContain('data-frick-brand="studio"');
    expect(html).toContain('data-frick-icon-pack="custom"');
  });
});

describe("runtime design context — icon pack resolution", () => {
  test("native vs frick icon packs resolve to different glyph sets", () => {
    for (const name of Object.keys(nativeIcons) as Array<keyof typeof nativeIcons>) {
      expect(iconPackFor("native")[name]).toBe(nativeIcons[name]);
      expect(iconPackFor("frick")[name]).toBe(frickIcons[name]);
      expect(frickIcons[name]).not.toBe(nativeIcons[name]);
    }
    // Any non-native pack (including custom) uses the brand fallback pack.
    expect(iconPackFor("custom").send).toBe(frickIcons.send);
  });

  test("IconButton renders the native (lucide) glyph by default", () => {
    const html = renderToStaticMarkup(
      <FrickDesignProvider>
        <IconButton icon="send" label="Send" />
      </FrickDesignProvider>,
    );
    expect(html).toContain("lucide");
  });

  test("IconButton renders the frick fallback glyph when icon pack switches", () => {
    const html = renderToStaticMarkup(
      <FrickDesignProvider iconPack="frick">
        <IconButton icon="send" label="Send" />
      </FrickDesignProvider>,
    );
    expect(html).not.toContain("lucide");
    expect(html).toContain("<svg");
    // The fallback send glyph is an inline path, not a lucide component.
    expect(html).toContain('viewBox="0 0 24 24"');
  });
});

describe("runtime design context — switch reducer", () => {
  const base: FrickDesignAxes = { ...defaultFrickDesignAxes };

  test("mergeDesignAxes applies a single-axis change", () => {
    expect(mergeDesignAxes(base, { mode: "dark" })).toEqual({
      mode: "dark",
      density: "regular",
      brand: "frick",
      iconPack: "native",
    });
  });

  test("mergeDesignAxes applies a multi-axis change at once", () => {
    expect(mergeDesignAxes(base, { density: "compact", brand: "frickenChat", iconPack: "frick" })).toEqual({
      mode: "light",
      density: "compact",
      brand: "frickenChat",
      iconPack: "frick",
    });
  });

  test("mergeDesignAxes never mutates a controlled axis", () => {
    const merged = mergeDesignAxes(base, { mode: "dark", brand: "frickenChat" }, { mode: true });
    expect(merged.mode).toBe("light"); // controlled — untouched
    expect(merged.brand).toBe("frickenChat"); // uncontrolled — updated
  });

  test("dataAttributesFor maps axes to selector attributes", () => {
    expect(dataAttributesFor({ mode: "dark", density: "compact", brand: "frickenChat", iconPack: "frick" })).toEqual({
      "data-frick-mode": "dark",
      "data-frick-density": "compact",
      "data-frick-brand": "frickenChat",
      "data-frick-icon-pack": "frick",
    });
  });
});

describe("runtime design context — exposed API", () => {
  test("context exposes setters and static token metadata", () => {
    let ctx: FrickDesignRuntime | undefined;
    renderToStaticMarkup(
      <FrickDesignProvider>
        <ContextProbe onRead={(value) => (ctx = value)} />
      </FrickDesignProvider>,
    );
    expect(typeof ctx?.setMode).toBe("function");
    expect(typeof ctx?.setDensity).toBe("function");
    expect(typeof ctx?.setBrand).toBe("function");
    expect(typeof ctx?.setIconPack).toBe("function");
    expect(typeof ctx?.setDesignContext).toBe("function");
    expect(ctx?.tokens).toBe(frickTokens);
  });

  test("useFrickDesign is an alias of useDesignContext", () => {
    let captured: FrickDesignRuntime | undefined;
    function DualProbe() {
      const a = useFrickDesign();
      const b = useDesignContext();
      expect(a).toBe(b);
      captured = a;
      return null;
    }
    renderToStaticMarkup(
      <FrickDesignProvider mode="dark">
        <DualProbe />
      </FrickDesignProvider>,
    );
    expect(captured?.mode).toBe("dark");
  });
});
