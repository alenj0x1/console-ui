// Notices at the top of the screen: an admin window the controller cannot
// drive (with its name), or the controller going to a game.
const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
here.listen("notice", ({ payload }) => {
  document.querySelector(".notice").dataset.kind = payload.kind;
  if (payload.kind === "admin") document.getElementById("name").textContent = payload.name || "Esta ventana";
});
// The buttons drawn as on the controller, as everywhere else.
const hint = document.getElementById("game-hint");
hint.replaceChildren(...withButtons(hint.textContent));
