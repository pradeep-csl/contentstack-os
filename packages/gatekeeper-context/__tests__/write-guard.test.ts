import { describe, expect, it } from "vitest";
import { webWriteRejection } from "../src/write-guard.js";

describe("webWriteRejection", () => {
  it("allows web-sourced collections", () => {
    expect(webWriteRejection("web")).toBeNull();
  });

  it("rejects git-based collections", () => {
    expect(webWriteRejection("git")).toMatch(/read-only/);
    expect(webWriteRejection("git")).toMatch(/git/);
  });

  it("rejects CI-published collections", () => {
    expect(webWriteRejection("push")).toMatch(/read-only/);
    expect(webWriteRejection("push")).toMatch(/CI/);
  });
});
