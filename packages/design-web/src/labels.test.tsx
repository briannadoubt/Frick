import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FrickLabelsProvider,
  WorkspaceShell,
  defaultComponentLabels,
  resolveLabel,
  type WorkspaceDestination,
} from "./index.js";

const destinations: WorkspaceDestination[] = [{ id: "home", label: "Home" }];

function shell(props: Partial<Parameters<typeof WorkspaceShell>[0]> = {}) {
  return (
    <WorkspaceShell
      destinations={destinations}
      selectedDestination="home"
      inspector={<div>inspector body</div>}
      {...props}
    />
  );
}

describe("component label localization", () => {
  test("renders the English default label outside any provider", () => {
    const html = renderToStaticMarkup(shell());
    expect(html).toContain(">Close</button>");
    expect(html).toContain(`aria-label="${defaultComponentLabels.closeInspector}"`);
  });

  test("FrickLabelsProvider overrides the built-in label", () => {
    const html = renderToStaticMarkup(
      <FrickLabelsProvider labels={{ closeInspector: "Cerrar" }}>{shell()}</FrickLabelsProvider>,
    );
    expect(html).toContain(">Cerrar</button>");
    expect(html).not.toContain(">Close</button>");
  });

  test("partial overrides fall back to English defaults for omitted keys", () => {
    // Empty override object -> everything stays English.
    const html = renderToStaticMarkup(<FrickLabelsProvider labels={{}}>{shell()}</FrickLabelsProvider>);
    expect(html).toContain(">Close</button>");
  });

  test("an inline prop override wins over the provider", () => {
    const html = renderToStaticMarkup(
      <FrickLabelsProvider labels={{ closeInspector: "Cerrar" }}>
        {shell({ closeInspectorLabel: "Fermer" })}
      </FrickLabelsProvider>,
    );
    expect(html).toContain(">Fermer</button>");
  });

  test("resolveLabel prefers the inline override, then the context value", () => {
    expect(resolveLabel("Fermer", "Close")).toBe("Fermer");
    expect(resolveLabel(undefined, "Close")).toBe("Close");
  });
});
