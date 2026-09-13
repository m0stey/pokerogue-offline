// The splash has no preload: it only ever prints one sentence, handed to it in the query string
// by src/main/dialogs.ts so that every German word lives in src/main/strings.de.ts.
(() => {
  const text = new URLSearchParams(location.search).get("text");
  if (text) document.getElementById("text").textContent = text;
})();
