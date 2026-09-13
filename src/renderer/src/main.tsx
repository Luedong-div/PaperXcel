import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

async function start() {
  if (!window.paperxcel && import.meta.env.DEV) {
    root.render(<main style={{ padding: 32 }}>正在连接桌面后端…</main>);
    const { connectBrowserApi } = await import("./browser-api");
    let failure: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        window.paperxcel = await connectBrowserApi();
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (failure) throw failure;
  }
  if (!window.paperxcel) throw new Error("请从 PaperXcel 桌面应用打开此页面。");
  const { default: App } = await import("./App");
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start().catch((error) =>
  root.render(
    <main style={{ padding: 32 }}>
      <h1>暂时无法连接 PaperXcel</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <button onClick={() => location.reload()}>重新连接</button>
    </main>,
  ),
);
