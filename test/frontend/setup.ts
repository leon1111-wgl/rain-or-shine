import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { setActiveLocale } from "../../web/src/i18n";

setActiveLocale("en");

afterEach(() => {
  if (typeof window === "undefined") return;
  cleanup();
  delete window.ethereum;
  window.location.hash = "";
});
