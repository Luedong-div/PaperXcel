import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const copyMainPdfWorkerPlugin = {
  name: "copy-main-pdf-worker",
  writeBundle(options: { dir?: string }) {
    if (!options.dir) return;
    copyFileSync(
      resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
      resolve(options.dir, "pdf.worker.min.mjs"),
    );
  },
};

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // Bundle pure JavaScript dependencies used by the main process so the
        // portable release does not ship their full source, maps, and typings.
        // Native/path-sensitive packages remain external.
        exclude: [
          "@thednp/dommatrix",
          "electron-store",
          "fast-xml-parser",
          "openai",
          "js-tiktoken",
          "pdf-lib",
          "pdfjs-dist",
        ],
      }),
      copyMainPdfWorkerPlugin,
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    server: {
      host: "127.0.0.1",
      proxy: process.env.PAPERXCEL_DEV_BRIDGE_PORT
        ? {
            "/__paperxcel": {
              target: `http://127.0.0.1:${process.env.PAPERXCEL_DEV_BRIDGE_PORT}`,
              changeOrigin: false,
              headers: {
                "x-paperxcel-proxy":
                  process.env.PAPERXCEL_DEV_BRIDGE_NONCE ?? "",
              },
            },
          }
        : undefined,
    },
    publicDir: resolve("public"),
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react()],
  },
});
