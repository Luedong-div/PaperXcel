import type { PaperXcelApi } from "../../shared/contracts";

declare global {
  interface Window {
    paperxcel: PaperXcelApi;
  }
}

export {};
