import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "./styles/tokens.css";
import "./styles/app.css";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import { SessionProvider } from "./lib/session";
import { TraceProvider } from "./lib/useTrace";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* Dil EN DISTA: oturum ve iz katmanlarinin urettigi metinler de
          cevrilebilir olmali. */}
      <I18nProvider>
        <SessionProvider>
          <TraceProvider>
            <App />
          </TraceProvider>
        </SessionProvider>
      </I18nProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
