import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const smallestKey = env.SMALLEST_AI_API_KEY;

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
      // Proxy WS to Smallest.ai so we can inject Authorization header (browser无法自定义 WS header)
      proxy: {
        "/asr-ws": {
          // http-proxy expects http/https; it will upgrade to ws/wss automatically
          target: "https://waves-api.smallest.ai",
          changeOrigin: true,
          ws: true,
          rewrite: (p) => p.replace(/^\/asr-ws/, ""),
          headers: smallestKey
            ? { Authorization: `Bearer ${smallestKey}` }
            : undefined,
        },
      },
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
