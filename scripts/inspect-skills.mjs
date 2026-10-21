import { readZipEntries } from "../src/shared/zip.ts";

const url = process.argv[2] ?? "https://ai.home.rutledge.ltd/api/skills/serve/all/download.zip";
const response = await fetch(url);
console.log("status", response.status, response.headers.get("content-type"));
const bytes = new Uint8Array(await response.arrayBuffer());
console.log("bytes", bytes.length);
const entries = readZipEntries(bytes);
for (const name of entries.keys()) console.log(name);
