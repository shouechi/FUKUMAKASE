import { defineConfig, mergeConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import base from "./vite.config";

export default defineConfig(
  mergeConfig(base, {
    plugins: [
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      }),
    ],
  }),
);
