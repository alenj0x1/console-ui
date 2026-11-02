// Notices at the top of the screen: an admin window the controller cannot
// drive (with its name), the controller going to a game, connecting or
// disconnecting, or its battery running low.
const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
here.listen("notice", ({ payload }) => {
  document.querySelector(".notice").dataset.kind = payload.kind;
  if (payload.kind === "admin") document.getElementById("name").textContent = payload.name || "Esta ventana";
  if (payload.kind === "connected") document.getElementById("battery").textContent = payload.name;
});
// The buttons drawn as on the controller, as everywhere else.
const hint = document.getElementById("game-hint");
hint.replaceChildren(...withButtons(hint.textContent));
