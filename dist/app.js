const entryDialog = document.querySelector("#entry-dialog");
const lobbyDialog = document.querySelector("#lobby-dialog");

entryDialog.addEventListener("cancel", (event) => event.preventDefault());
entryDialog.querySelectorAll("[data-entry-mode]").forEach((button) => button.addEventListener("click", async () => {
  const mode = button.dataset.entryMode;
  entryDialog.close();
  if (mode === "single") {
    const { startSinglePlayerApp } = await import("./modules/single-player.js");
    await startSinglePlayerApp();
    return;
  }
  const { startMultiplayerApp } = await import("./modules/multiplayer.js");
  await startMultiplayerApp({ entryDialog, lobbyDialog });
}));

entryDialog.showModal();
