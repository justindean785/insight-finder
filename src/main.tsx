import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { installGlobalHandlers } from "./lib/telemetry";

// Catch uncaught errors + unhandled promise rejections before first render.
installGlobalHandlers();

createRoot(document.getElementById("root")!).render(<App />);
