// Notices at the top of the screen: an admin window the controller cannot
// drive (with its name), the controller going to a game, connecting or
// disconnecting, or its battery running low.
const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
// The admin window's name, if the app knows it.
let adminName = "";
here.listen("notice", ({ payload }) => {
  document.querySelector(".notice").dataset.kind = payload.kind;
  if (payload.kind === "admin") {
    adminName = payload.name || "";
    showName();
  }
  if (payload.kind === "connected") document.getElementById("battery").textContent = payload.name;
});
function showName() {
  document.getElementById("name").textContent = adminName || t("notice.this_window");
}
// The buttons drawn as on the controller, as everywhere else.
function showHint() {
  document.getElementById("game-hint").replaceChildren(...withButtons(t("notice.game_hint")));
}
// B goes back, drawn as on the controller (the button that does it now).
function showBack() {
  setGlyph(document.getElementById("back-key"), "B");
}
showName();
showHint();
showBack();
Prefs.watch(showBack);
// Another interface language: the texts set here follow ([data-i18n] ones
// follow by themselves).
I18n.watch(() => {
  showName();
  showHint();
});
