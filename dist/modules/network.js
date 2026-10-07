let socketClientPromise = null;

function loadSocketClient() {
  if (window.io) return Promise.resolve(window.io);
  if (socketClientPromise) return socketClientPromise;
  socketClientPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/socket.io/socket.io.js";
    script.async = true;
    script.addEventListener("load", () => window.io ? resolve(window.io) : reject(new Error("Socket.IO 客户端未能初始化。")), { once: true });
    script.addEventListener("error", () => reject(new Error("无法载入联机组件。请使用 npm start 或 启动游戏.cmd 启动 Node.js 服务器。")), { once: true });
    document.head.append(script);
  });
  return socketClientPromise;
}

export async function createNetworkClient() {
  const io = await loadSocketClient();
  const socket = io({ transports: ["websocket", "polling"], timeout: 5000 });

  function request(event, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!socket.connected) {
        reject(new Error("尚未连接服务器。"));
        return;
      }
      const timer = window.setTimeout(() => reject(new Error(`${event} 请求超时。`)), 6000);
      socket.emit(event, payload, (response) => {
        window.clearTimeout(timer);
        if (response?.ok) resolve(response.data);
        else {
          const error = new Error(response?.error?.message ?? "服务器拒绝了请求。");
          error.code = response?.error?.code;
          reject(error);
        }
      });
    });
  }

  return { socket, request };
}
