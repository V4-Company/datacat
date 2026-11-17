import type { Request } from "express";

export const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new Error("PUBLIC_URL must be an http(s) URL");
// Without it, links and the agent installer would be built from the request's Host header.
if (process.env.NODE_ENV === "production" && !publicUrl) throw new Error("Set PUBLIC_URL to DataCat's external URL, e.g. https://observe.example.com");
export function getOrigin(req: Request): string {
  return publicUrl ?? `${req.protocol}://${req.get("host")}`;
}
export const secureCookies = publicUrl ? new URL(publicUrl).protocol === "https:" : process.env.NODE_ENV === "production";
if (process.env.NODE_ENV === "production" && (process.env.SESSION_SECRET?.length ?? 0) < 32) {
  throw new Error("Set SESSION_SECRET to a random value of at least 32 characters");
}
