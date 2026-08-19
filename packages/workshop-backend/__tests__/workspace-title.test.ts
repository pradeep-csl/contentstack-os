import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_TITLE } from "@gadgets/workshop-shared/api";
import { isReplaceableWorkspaceTitle } from "../src/workspace-title.js";

describe("isReplaceableWorkspaceTitle", () => {
  it("treats the current default as replaceable", () => {
    expect(isReplaceableWorkspaceTitle(DEFAULT_WORKSPACE_TITLE)).toBe(true);
  });

  it("treats the pre-rename default in old records as replaceable", () => {
    expect(isReplaceableWorkspaceTitle("Untitled Gadget")).toBe(true);
  });

  it("protects a title a person chose", () => {
    expect(isReplaceableWorkspaceTitle("GTM Q3")).toBe(false);
  });

  it("protects a title that merely contains the default", () => {
    expect(isReplaceableWorkspaceTitle("Untitled Workspace copy")).toBe(false);
  });

  it("does not treat a padded default as replaceable, since no writer stores one", () => {
    expect(isReplaceableWorkspaceTitle(" Untitled Workspace ")).toBe(false);
  });

  // Matches today's behavior: the old inline check was an array `.includes()`, so an empty title
  // was never auto-replaced either. Preserved deliberately -- setTitle("") is reachable.
  it("does not treat an empty title as replaceable", () => {
    expect(isReplaceableWorkspaceTitle("")).toBe(false);
  });
});
