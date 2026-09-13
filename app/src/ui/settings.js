// Runs in the settings window. Talks to the app only through the four calls in preload-ui.ts.
(async () => {
  const api = window.pokerogue;

  const show = (data) => {
    if (!data) return;
    for (const input of document.querySelectorAll('input[name="conflict"]')) {
      input.checked = input.value === data.conflictPolicy;
    }
    for (const input of document.querySelectorAll('input[name="metered"]')) {
      input.checked = input.value === data.allowMeteredDownloads;
    }
    document.getElementById("backups-dir").textContent = data.backupsDir;
    document.getElementById("game-version").textContent = data.gameVersion;
    document.getElementById("last-saved").textContent = data.lastSavedOnline;
    document.getElementById("play-time").textContent = data.playTime;
  };

  const save = async (patch) => {
    try {
      show(await api.submit(patch));
    } catch (err) {
      /* nothing useful to tell the user here */
    }
  };

  for (const input of document.querySelectorAll('input[name="conflict"]')) {
    input.addEventListener("change", () => save({ conflictPolicy: input.value }));
  }
  for (const input of document.querySelectorAll('input[name="metered"]')) {
    input.addEventListener("change", () => save({ allowMeteredDownloads: input.value }));
  }
  document.getElementById("open-backups").addEventListener("click", () => api.openBackups());

  try {
    show(await api.data());
  } catch (err) {
    /* leave the dashes */
  }
})();
