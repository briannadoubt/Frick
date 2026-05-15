const tools = [
  { id: "tilt", label: "Tilt", url: "http://localhost:10350" },
  { id: "web-tilt", label: "Web · Tilt", url: "http://127.0.0.1:5173" },
  { id: "web-preview", label: "Web · Preview", url: "http://127.0.0.1:5273" },
  { id: "schema-tilt", label: "Schema · 4099", url: "http://127.0.0.1:4099/schema" },
  { id: "health-tilt", label: "Health · 4099", url: "http://127.0.0.1:4099/health" },
  { id: "schema-prev", label: "Schema · 4199", url: "http://127.0.0.1:4199/schema" },
  { id: "health-prev", label: "Health · 4199", url: "http://127.0.0.1:4199/health" },
];

const nav = document.getElementById("tabs");
const panel = document.getElementById("panel");
const openLink = document.getElementById("open-link");
let fallbackTimer = 0;

function selectTab(id) {
  const tool = tools.find((candidate) => candidate.id === id);
  if (!tool) return;

  window.clearTimeout(fallbackTimer);
  for (const btn of nav.querySelectorAll("button.tab")) {
    btn.setAttribute("aria-selected", btn.dataset.id === id ? "true" : "false");
  }

  panel.replaceChildren();
  const iframe = document.createElement("iframe");
  iframe.src = tool.url;
  iframe.setAttribute("loading", "eager");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("sandbox", "allow-forms allow-same-origin allow-scripts");
  panel.appendChild(iframe);

  const fallback = document.createElement("div");
  fallback.className = "empty";
  fallback.hidden = true;

  const blockReason = document.createElement("div");
  blockReason.append("If this panel is blank, the target may block embedded frames with ");
  const headerName = document.createElement("code");
  headerName.textContent = "X-Frame-Options";
  blockReason.append(headerName, " or a similar policy.");

  const openPrompt = document.createElement("div");
  openPrompt.append("Open ");
  const fallbackLink = document.createElement("a");
  fallbackLink.className = "open-link";
  fallbackLink.href = tool.url;
  fallbackLink.target = "_blank";
  fallbackLink.rel = "noopener";
  fallbackLink.textContent = tool.url;
  openPrompt.append(fallbackLink, " in a new tab.");

  fallback.append(blockReason, openPrompt);
  panel.appendChild(fallback);

  const showFallback = () => {
    fallback.hidden = false;
  };
  const clearFallbackTimer = () => {
    window.clearTimeout(timer);
    if (fallbackTimer === timer) fallbackTimer = 0;
  };
  const hideFallback = () => {
    clearFallbackTimer();
    fallback.hidden = true;
  };
  const iframeRenderState = () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return "unknown";
      const text = doc.body?.textContent?.trim() ?? "";
      if (doc.location.href === "about:blank" || (doc.body?.children.length === 0 && text.length === 0)) {
        return "blank";
      }
      return "rendered";
    } catch {
      return "unknown";
    }
  };
  const timer = window.setTimeout(() => {
    if (fallbackTimer === timer) showFallback();
  }, 2500);
  fallbackTimer = timer;
  iframe.addEventListener(
    "load",
    () => {
      clearFallbackTimer();
      const renderState = iframeRenderState();
      if (renderState === "blank") {
        showFallback();
      } else {
        hideFallback();
      }
    },
    { once: true },
  );
  iframe.addEventListener(
    "error",
    () => {
      clearFallbackTimer();
      showFallback();
    },
    { once: true },
  );

  openLink.href = tool.url;
  openLink.textContent = `Open ${tool.label} ↗`;
  history.replaceState(null, "", `#${id}`);
}

for (const tool of tools) {
  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.id = tool.id;
  btn.textContent = tool.label;
  btn.addEventListener("click", () => selectTab(tool.id));
  nav.appendChild(btn);
}

const initial = location.hash.slice(1) || tools[0].id;
selectTab(initial);
