import { createClient, StorageApiError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "./limits";
import { describeLimitError } from "./limitGuards";

// The module under test reads its Supabase client from "./supabase"; swap in whichever
// client the current test wants.
const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./supabase", () => ({
  get supabase() {
    return state.client;
  },
}));

import { cvStoragePath, uploadRemoteCv } from "./cvsRemote";

const USER = "99999999-9999-4999-8999-999999999999";
const CV_ID = "11111111-1111-4111-8111-111111111111";

/** A stand-in for the Supabase calls uploadRemoteCv makes, recording what it got and in
 *  what order. `existingRecord` says whether the CV already has a details row. */
function fakeClient(
  opts: { uploadError?: unknown; rowError?: unknown; existingRecord?: boolean } = {},
) {
  const calls = {
    uploads: [] as { path: string; body: Blob; options: Record<string, unknown> }[],
    rows: [] as Record<string, unknown>[],
    deletedIds: [] as string[],
    order: [] as string[],
  };
  const client = {
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("cvs");
        return {
          upload: async (path: string, body: Blob, options: Record<string, unknown>) => {
            calls.order.push("file");
            calls.uploads.push({ path, body, options });
            return opts.uploadError
              ? { data: null, error: opts.uploadError }
              : { data: { path }, error: null };
          },
        };
      },
    },
    from: (table: string) => {
      expect(table).toBe("cvs");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.existingRecord ? { id: "existing" } : null,
              error: null,
            }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          calls.order.push("record");
          calls.rows.push(row);
          return { error: opts.rowError ?? null };
        },
        delete: () => ({
          eq: async (_column: string, id: string) => {
            calls.order.push("record-removed");
            calls.deletedIds.push(id);
            return { error: null };
          },
        }),
      };
    },
  };
  return { client, calls };
}

const cv = (file: Blob, name: string, over: Record<string, unknown> = {}) => ({
  userId: USER,
  id: CV_ID,
  name,
  role: "tech" as const,
  type: (file as File).type ?? "",
  dateAdded: "2026-10-01T00:00:00.000Z",
  blob: file,
  ...over,
});

beforeEach(() => {
  state.client = null;
});

describe("uploadRemoteCv", () => {
  it("uploads a Blob that carries the canonical type even when the File's own type is empty", async () => {
    const { client, calls } = fakeClient();
    state.client = client;
    // Browsers often report "" for Word files.
    const file = new File(["word bytes"], "My CV.docx", { type: "" });
    expect(file.type).toBe("");

    const path = await uploadRemoteCv(cv(file, file.name));

    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(path).toBe(`${USER}/${CV_ID}`);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0].path).toBe(`${USER}/${CV_ID}`);
    expect(calls.uploads[0].body).toBeInstanceOf(Blob);
    expect(calls.uploads[0].body.type).toBe(docx);
    expect(calls.uploads[0].options).toMatchObject({ contentType: docx, upsert: true });
    expect(calls.rows[0]).toMatchObject({ type: docx });
  });

  it.each([
    ["resume.pdf", "", "application/pdf"],
    ["RESUME.PDF", "text/plain", "application/pdf"], // the name wins over a wrong type
    ["old.doc", "", "application/msword"],
    ["new.DOCX", "", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ])("types %s as %s", async (name, givenType, expected) => {
    const { client, calls } = fakeClient();
    state.client = client;
    await uploadRemoteCv(cv(new File(["x"], name, { type: givenType }), name));
    expect(calls.uploads[0].body.type).toBe(expected);
    expect(calls.rows[0].type).toBe(expected);
  });

  it("does not turn .docx into .doc", async () => {
    const { client, calls } = fakeClient();
    state.client = client;
    await uploadRemoteCv(cv(new File(["x"], "a.docx"), "a.docx"));
    await uploadRemoteCv(cv(new File(["x"], "a.doc"), "a.doc"));
    expect(calls.uploads[0].body.type).not.toBe(calls.uploads[1].body.type);
  });

  it("falls back to the file's own type when the name is not a known CV type", async () => {
    const { client, calls } = fakeClient();
    state.client = client;
    await uploadRemoteCv(cv(new File(["x"], "notes.txt", { type: "text/plain" }), "notes.txt"));
    expect(calls.uploads[0].body.type).toBe("text/plain");
    expect(calls.rows[0].type).toBe("text/plain");
  });

  it("records the real size of the file, not a number the caller supplies", async () => {
    const { client, calls } = fakeClient();
    state.client = client;
    const file = new File([new Uint8Array(1234)], "cv.pdf");
    await uploadRemoteCv(cv(file, "cv.pdf", { size: 5 }));
    expect(calls.rows[0].size).toBe(1234);
    expect(calls.uploads[0].body.size).toBe(1234);
  });

  it("keeps the file's bytes intact", async () => {
    const { client, calls } = fakeClient();
    state.client = client;
    await uploadRemoteCv(cv(new File(["hello cv"], "cv.pdf"), "cv.pdf"));
    expect(await calls.uploads[0].body.text()).toBe("hello cv");
  });

  it("trims the details row to the database limits and keeps the file ending", async () => {
    const { client, calls } = fakeClient();
    state.client = client;
    const longName = "a".repeat(600) + ".pdf";
    await uploadRemoteCv(cv(new File(["x"], longName), longName, { role: "r".repeat(99) }));
    const row = calls.rows[0] as { name: string; role: string; type: string };
    expect(row.name).toHaveLength(LIMITS.cv.name);
    expect(row.name.endsWith(".pdf")).toBe(true);
    expect(row.role).toHaveLength(LIMITS.cv.role);
    expect(row).toMatchObject({ id: CV_ID, user_id: USER, path: `${USER}/${CV_ID}` });
  });

  it("builds the storage path from lower-case ids, as the database's path rule requires", async () => {
    // The database checks path = user_id::text || '/' || id::text, which is always lower-case.
    // (These ids contain hex letters, so upper-casing them really changes them.)
    const user = "abcdef01-2345-4678-89ab-cdef01234567";
    const cvId = "fedcba98-7654-4321-8fed-cba987654321";
    expect(cvStoragePath(user, cvId)).toBe(`${user}/${cvId}`);
    expect(cvStoragePath(user.toUpperCase(), cvId.toUpperCase())).toBe(`${user}/${cvId}`);

    const { client, calls } = fakeClient();
    state.client = client;
    await uploadRemoteCv(
      cv(new File(["x"], "cv.pdf"), "cv.pdf", {
        userId: user.toUpperCase(),
        id: cvId.toUpperCase(),
      }),
    );
    // The file and the details row agree on one lower-case path.
    expect(calls.uploads[0].path).toBe(`${user}/${cvId}`);
    expect(calls.rows[0].path).toBe(`${user}/${cvId}`);
  });

  it("lets a storage error through unchanged, so the caller can explain it", async () => {
    const refusal = new StorageApiError("The object exceeded the maximum allowed size", 413, "413");
    const { client, calls } = fakeClient({ uploadError: refusal });
    state.client = client;
    const thrown = await uploadRemoteCv(cv(new File(["x"], "cv.pdf"), "cv.pdf")).catch((e) => e);
    expect(thrown).toBe(refusal);
    expect(describeLimitError(thrown, "cv-upload")).toContain("5.0 MB");
    // The record went first (storage insists on it), so a refused file takes it back out:
    // no CV in the list whose file never arrived.
    expect(calls.order).toEqual(["record", "file", "record-removed"]);
    expect(calls.deletedIds).toEqual([CV_ID]);
  });

  it("saves the CV record BEFORE the file, because storage only accepts files for an existing record", async () => {
    const { client, calls } = fakeClient();
    state.client = client;
    await uploadRemoteCv(cv(new File(["x"], "cv.pdf"), "cv.pdf"));
    expect(calls.order).toEqual(["record", "file"]);
  });

  it("does not remove the record of a CV that already existed when its re-upload is refused", async () => {
    const refusal = new StorageApiError("too big", 413, "413");
    const { client, calls } = fakeClient({ uploadError: refusal, existingRecord: true });
    state.client = client;
    await expect(uploadRemoteCv(cv(new File(["x"], "cv.pdf"), "cv.pdf"))).rejects.toBe(refusal);
    expect(calls.deletedIds).toEqual([]); // it had a working file before; leave it
  });

  it("lets a database error on the details row through unchanged", async () => {
    const refusal = Object.assign(new Error("FireHunt limit: an account can keep at most 10 CVs. Delete some to add more."), {
      code: "54000",
      details: "",
      hint: "",
    });
    const { client, calls } = fakeClient({ rowError: refusal });
    state.client = client;
    const thrown = await uploadRemoteCv(cv(new File(["x"], "cv.pdf"), "cv.pdf")).catch((e) => e);
    expect(thrown).toBe(refusal);
    expect(describeLimitError(thrown, "cv-upload")).toBe(
      "An account can keep at most 10 CVs. Delete some to add more.",
    );
    expect(calls.uploads).toHaveLength(0); // no record, so no file is even attempted
  });

  it("refuses to run when sync is not configured", async () => {
    state.client = null;
    await expect(uploadRemoteCv(cv(new File(["x"], "cv.pdf"), "cv.pdf"))).rejects.toThrow(
      "Sync is not configured.",
    );
  });
});

describe("what the Storage server actually receives (real supabase-js, fake network)", () => {
  /** Run an upload through the real client and report the file part's type. */
  async function typeSeenByServer(file: File, name: string) {
    const seen: { url: string; partType?: string; partName?: string; rows: unknown[] } = {
      url: "",
      rows: [],
    };
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/storage/v1/object/")) {
        seen.url = url;
        const form = init?.body as FormData;
        const part = form.get("") as File;
        seen.partType = part.type;
        return new Response(JSON.stringify({ Id: "id-1", Key: "cvs/path" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if ((init?.method ?? "GET") === "GET") {
        // "Does this CV already have a record?" -> no.
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      seen.rows.push(JSON.parse(String(init?.body ?? "null")));
      return new Response(null, { status: 201 });
    };
    state.client = createClient("http://localhost:54321", "anon-key", {
      global: { fetch: fakeFetch },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    await uploadRemoteCv(cv(file, name));
    return seen;
  }

  it("sends the canonical type for a Word file the browser could not identify", async () => {
    const seen = await typeSeenByServer(new File(["x"], "cv.docx", { type: "" }), "cv.docx");
    expect(seen.url).toContain(`/object/cvs/${USER}/${CV_ID}`);
    expect(seen.partType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(seen.rows[0]).toMatchObject({ type: seen.partType, size: 1 });
  });

  it("sends application/pdf for a PDF", async () => {
    const seen = await typeSeenByServer(new File(["%PDF"], "cv.pdf", { type: "" }), "cv.pdf");
    expect(seen.partType).toBe("application/pdf");
  });
});
