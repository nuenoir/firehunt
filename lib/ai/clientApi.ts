// lib/ai/clientApi.ts
// BROWSER-SIDE helpers for calling FireHunt's own AI endpoints. They attach the
// signed-in user's token and turn every outcome into a plain result object, so UI
// code never has to deal with fetch errors or non-JSON responses.

import type { Extraction, StoredAnalysis } from "./schemas";

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

async function post<T>(
  path: string,
  token: string,
  body: unknown,
  pick: (json: Record<string, unknown>) => T | undefined,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message:
          typeof json.error === "string"
            ? json.error
            : "Something went wrong. Please try again.",
      };
    }
    const value = pick(json);
    if (value === undefined) {
      return { ok: false, status: 502, message: "Unexpected response from the server." };
    }
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Couldn't reach the server. Check your connection and try again.",
    };
  }
}

export interface CapturePayload {
  title: string;
  company: string;
  url: string;
  salary: string;
  text: string;
}

export function requestExtraction(
  token: string,
  payload: CapturePayload,
): Promise<ApiResult<Extraction>> {
  return post(
    "/api/ai/extract",
    token,
    payload,
    (j) => j.extraction as Extraction | undefined,
  );
}

export interface AnalyzePayload {
  title: string;
  company: string;
  description: string;
  cvId: string;
  contacts: { name: string; role: string; value: string }[];
}

export function requestAnalysis(
  token: string,
  payload: AnalyzePayload,
): Promise<ApiResult<StoredAnalysis>> {
  return post(
    "/api/ai/analyze",
    token,
    payload,
    (j) => j.analysis as StoredAnalysis | undefined,
  );
}
