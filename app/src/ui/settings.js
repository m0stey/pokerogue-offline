// Runs in the settings window. Talks to the app only through the four calls in preload-ui.ts.
// Every word it prints comes from the app (src/main/strings.de.ts); this file has none of its own.
(async () => {
  const api = window.pokerogue;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const labels = (t) => {
    set("t-heading", t.heading);
    set("t-conflict-heading", t.conflictHeading);
    set("t-conflict-ask", t.conflictAsk);
    set("t-conflict-here", t.conflictHere);
    set("t-conflict-online", t.conflictOnline);
    set("t-backups-heading", t.backupsHeading);
    set("open-backups", t.openFolder);
    set("t-about-heading", t.aboutHeading);
    set("t-game-version", t.gameVersion);
    set("t-last-saved", t.lastSavedOnline);
    set("t-play-time", t.playTime);
    set("t-footnote", t.footnote);
    document.title = t.heading;
  };

  const show = (data) => {
    if (!data) return;
    if (data.text) labels(data.text);
    for (const input of document.querySelectorAll('input[name="conflict"]')) {
      input.checked = input.value === data.conflictPolicy;
    }
    set("backups-dir", data.backupsDir);
    set("game-version", data.gameVersion);
    set("last-saved", data.lastSavedOnline);
    set("play-time", data.playTime);
  };

  const save = async (patch) => {
    try {
      show(await api.submit(patch));
    } catch (err) {
      /* nothing useful to tell her here */
    }
  };

  for (const input of document.querySelectorAll('input[name="conflict"]')) {
    input.addEventListener("change", () => save({ conflictPolicy: input.value }));
  }
  document.getElementById("open-backups").addEventListener("click", () => api.openBackups());

  try {
    show(await api.data());
  } catch (err) {
    /* leave the dashes */
  }
})();
