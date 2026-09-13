// Runs in the conflict window. Talks to the app only through the four calls in preload-ui.ts.
(async () => {
  const api = window.pokerogue;

  const fill = (prefix, card) => {
    if (!card) return;
    document.getElementById(prefix + "-playtime").textContent = card.playTime;
    document.getElementById(prefix + "-last").textContent = card.lastPlayed;
    if (card.run === null || card.run === undefined) {
      // The system save has no run, so the row would say nothing useful.
      document.getElementById(prefix + "-run-label").hidden = true;
      document.getElementById(prefix + "-run").hidden = true;
    } else {
      document.getElementById(prefix + "-run").textContent = card.run;
    }
  };

  try {
    const data = await api.data();
    if (data) {
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
