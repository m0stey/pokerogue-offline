// Update window. It asks the main process for the current state twice a second and draws it.
// Words come from src/main/strings.de.ts via the state object; this file holds none of its own.
(() => {
  const $ = (id) => document.getElementById(id);
  let lastPhase = "";

  const draw = (s) => {
    if (!s) return;
    $("text").textContent = s.text;
    const downloading = s.phase === "downloading";
    $("bar").hidden = !downloading;
    $("progress").hidden = !downloading;
    if (downloading) {
      $("fill").style.width = `${Math.round((s.fraction || 0) * 100)}%`;
      $("progress").textContent = s.progressText || "";
    }
    if (s.phase !== lastPhase) {
      lastPhase = s.phase;
      $("primary").textContent = s.primary || "";
      $("primary").hidden = !s.primary;
      $("secondary").textContent = s.secondary || "";
      $("secondary").hidden = !s.secondary;
      if (s.primary) $("primary").focus();
    }
  };

  $("primary").addEventListener("click", () => window.pokerogue.submit({ phase: lastPhase, button: "primary" }));
  $("secondary").addEventListener("click", () => window.pokerogue.submit({ phase: lastPhase, button: "secondary" }));

  const tick = async () => {
    try {
      draw(await window.pokerogue.data());
    } catch {
      /* the window is closing */
    }
  };
  void tick();
  setInterval(tick, 500);
})();
