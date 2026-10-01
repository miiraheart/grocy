// grocy-test access for the live tests. Keys are read here, never printed. Only grocy-test.audibox.cc is allowed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROCY_TEST = "https://grocy-test.audibox.cc/api";

export function credential(name) {
  const text = readFileSync(join(homedir(), ".config", "grocy", "credentials"), "utf8");
  const line = text.split("\n").reverse().find((l) => l.startsWith(name + "="));
  const value = line ? line.slice(name.length + 1).replace(/["'\r\s]/g, "") : "";
  if (!value) throw new Error(name + " missing from ~/.config/grocy/credentials");
  return value;
}

export async function grocy(method, path, body) {
  const url = GROCY_TEST + path;
  if (!url.startsWith("https://grocy-test.audibox.cc/")) throw new Error("refusing " + url);
  const res = await fetch(url, { method, headers: { "GROCY-API-KEY": credential("GROCY_API_KEY"), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(method + " " + path + " " + res.status + " " + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

export const recipeFields = (id) => grocy("GET", "/userfields/recipes/" + id);

// Deletes every "ZZ test" recipe the tests left behind.
export async function sweep() {
  const all = await grocy("GET", "/objects/recipes?query%5B%5D=type%3Dnormal");
  for (const r of all.filter((x) => /^ZZ test/i.test(x.name))) await grocy("DELETE", "/objects/recipes/" + r.id);
}
