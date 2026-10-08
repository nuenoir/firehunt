import { describe, expect, it } from "vitest";
import {
  inferLocalOwner,
  mustWipeBeforeSignIn,
  shouldWipeOnSignOut,
} from "./localOwnership";

describe("inferLocalOwner", () => {
  it("trusts the explicit marker over any sync history", () => {
    expect(inferLocalOwner("alice", ["bob"])).toEqual({ kind: "user", id: "alice" });
  });

  it("with no marker and no history, the data belongs to nobody", () => {
    expect(inferLocalOwner(null, [])).toEqual({ kind: "none" });
  });

  it("infers the owner from a single account's sync history (older browsers)", () => {
    expect(inferLocalOwner(null, ["alice", "alice"])).toEqual({ kind: "user", id: "alice" });
  });

  it("is ambiguous when several accounts have synced here", () => {
    expect(inferLocalOwner(null, ["alice", "bob"])).toEqual({ kind: "ambiguous" });
  });
});

describe("mustWipeBeforeSignIn", () => {
  it("keeps data when the same account signs back in", () => {
    expect(mustWipeBeforeSignIn({ kind: "user", id: "alice" }, "alice")).toBe(false);
  });

  it("wipes first when a DIFFERENT account signs in (the shared-browser leak)", () => {
    expect(mustWipeBeforeSignIn({ kind: "user", id: "alice" }, "bob")).toBe(true);
  });

  it("lets signed-out data migrate into whichever account signs in", () => {
    expect(mustWipeBeforeSignIn({ kind: "none" }, "bob")).toBe(false);
  });

  it("wipes when ownership can't be determined", () => {
    expect(mustWipeBeforeSignIn({ kind: "ambiguous" }, "alice")).toBe(true);
  });
});

describe("shouldWipeOnSignOut", () => {
  it("clears data that belongs to an account", () => {
    expect(shouldWipeOnSignOut({ kind: "user", id: "alice" })).toBe(true);
    expect(shouldWipeOnSignOut({ kind: "ambiguous" })).toBe(true);
  });

  it("never clears work the visitor did while signed out", () => {
    expect(shouldWipeOnSignOut({ kind: "none" })).toBe(false);
  });
});
