import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      // circuits build ciktilarini (wasm/zkey) gelistirmede sunabilmek icin.
      allow: [".."],
    },
  },
  define: {
    // ethers/snarkjs bazi ortamlarda global bekler.
    global: "globalThis",
  },
});
