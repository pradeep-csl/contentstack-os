import { describe, expect, it } from "vitest";
import { railStatusLabel, railToneFor } from "./chatRail";

describe("railToneFor", () => {
  it("keeps settled prose nodes neutral, since neither succeeds nor fails", () => {
    expect(railToneFor({ type: "thinking" })).toBe("neutral");
    expect(railToneFor({ type: "text" })).toBe("neutral");
  });

  it("holds prose the agent is still producing at pending", () => {
    expect(railToneFor({ type: "thinking", inFlight: true })).toBe("pending");
    expect(railToneFor({ type: "text", inFlight: true })).toBe("pending");
  });

  it("marks a settled tool group by whether anything in it errored", () => {
    expect(railToneFor({ type: "toolGroup", hasError: false })).toBe("success");
    expect(railToneFor({ type: "toolGroup", hasError: true })).toBe("danger");
  });

  it("holds an in-flight group at pending, because the outcome isn't known yet", () => {
    expect(railToneFor({ type: "toolGroup", hasError: false, inFlight: true })).toBe("pending");
  });

  it("still reports an error seen mid-stream: a failed call cannot become successful", () => {
    // A group streams in call by call, so an error can land before the turn settles. Showing it
    // as pending would walk the dot back from red to red via green.
    expect(railToneFor({ type: "toolGroup", hasError: true, inFlight: true })).toBe("danger");
  });
});

describe("railStatusLabel", () => {
  it("gives the dot's colour a text equivalent, so hue is never the only signal", () => {
    expect(railStatusLabel("success")).toBe("Succeeded");
    expect(railStatusLabel("danger")).toBe("Failed");
    expect(railStatusLabel("pending")).toBe("Running");
  });

  it("says nothing for a neutral dot, whose content already speaks for itself", () => {
    expect(railStatusLabel("neutral")).toBeNull();
  });
});
