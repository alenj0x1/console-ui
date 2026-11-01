// Admin window notice: shows the name of the window the controller cannot drive.
const here = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
here.listen("notice", ({ payload }) => {
  document.getElementById("name").textContent = payload || "Esta ventana";
});
