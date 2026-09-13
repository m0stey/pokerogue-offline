// Runs in the conflict window. Talks to the app only through the four calls in preload-ui.ts.
// Every word it prints comes from the app (src/main/strings.de.ts); this file has none of its own.
(async () => {
  const api = window.pokerogue;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const labels = (t) => {
    set("t-heading", t.heading);
    set("t-lead", t.lead);
    set("t-here", t.here);
    set("t-online", t.online);
    set("t-playtime-here", t.playTime);
    set("t-playtime-online", t.playTime);
    set("t-last-here", t.lastPlayed);
    set("t-last-online", t.lastPlayed);
    set("here-run-label", t.run);
    set("online-run-label", t.run);
    set("keep-here", t.keep);
    set("keep-online", t.keep);
    set("t-note", t.note);
    set("t-remember", t.remember);
    document.title = t.heading;
  };

  const fill = (prefix, card) => {
    if (!card) return;
    set(prefix + "-playtime", card.playTime);
    set(prefix + "-last", card.lastPlayed);
    if (card.run === null || card.run === undefined) {
      // The system save has no run, so the row would say nothing useful.
      document.getElementById(prefix + "-run-label").hidden = true;
      document.getElementById(prefix + "-run").hidden = true;
    } else {
      set(prefix + "-run", card.run);
    }
  };

  try {
    const data = await api.data();
    if (data) {
      if (data.text) labels(data.text);
      fill("here", data.here);
      fill("online", data.online);
    }
  } catch (err) {
    /* the buttons still work */
  }

  const send = (keep) => {
    const remember = document.getElementById("remember").checked;
    document.getElementById("keep-here").disabled = true;
    document.getElementById("keep-online").disabled = true;
    api.submit({ keep, remember });
  };
  document.getElementById("keep-here").addEventListener("click", () => send("this-computer"));
  document.getElementById("keep-online").addEventListener("click", () => send("online"));
})();
