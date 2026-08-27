import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "./styles/tokens.css";
import "./styles/app.css";
import App from "./App";
import { SessionProvider } from "./lib/session";
import { TraceProvider } from "./lib/useTrace";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <TraceProvider>
          <App />
        </TraceProvider>
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
