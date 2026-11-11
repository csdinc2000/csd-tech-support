import fs from "fs";

// Replit key-value store helper. We use this (instead of a new Postgres column)
// to hold the optional custom voicemail-greeting audio, because `db:push` is
// unavailable in this repl. The KV store persists across restarts and deploys.

function dbBase(): string {
  try {
    const f = fs.readFileSync("/tmp/replitdb", "utf8").trim();
    if (f) return f;
  } catch {
    // fall through to env var
  }
  return process.env.REPLIT_DB_URL || "";
}

async function kvGet(key: string): Promise<string | null> {
  const base = dbBase();
  if (!base) return null;
  const res = await fetch(`${base}/${encodeURIComponent(key)}`);
  if (!res.ok) return null;
  const text = await res.text();
  return text.length ? text : null;
}

async function kvSet(key: string, value: string): Promise<void> {
  const base = dbBase();
  if (!base) throw new Error("Key-value store unavailable");
  const body = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    if (res.status === 413) throw new Error("Recording is too large to store. Please upload a shorter or more compressed audio file.");
    throw new Error(`Could not save the recording (storage error ${res.status}).`);
  }
}

async function kvDel(key: string): Promise<void> {
  const base = dbBase();
  if (!base) return;
  await fetch(`${base}/${encodeURIComponent(key)}`, { method: "DELETE" });
}

const AUDIO_KEY = "vm_greeting_audio_b64";
const CT_KEY = "vm_greeting_audio_ct";
const NAME_KEY = "vm_greeting_audio_name";

export async function getGreetingAudio(): Promise<{ buf: Buffer; contentType: string } | null> {
  const b64 = await kvGet(AUDIO_KEY);
  if (!b64) return null;
  const ct = (await kvGet(CT_KEY)) || "audio/mpeg";
  return { buf: Buffer.from(b64, "base64"), contentType: ct };
}

export async function setGreetingAudio(buf: Buffer, contentType: string, fileName?: string): Promise<void> {
  await kvSet(AUDIO_KEY, buf.toString("base64"));
  await kvSet(CT_KEY, contentType);
  if (fileName) await kvSet(NAME_KEY, fileName);
}

export async function clearGreetingAudio(): Promise<void> {
  await kvDel(AUDIO_KEY);
  await kvDel(CT_KEY);
  await kvDel(NAME_KEY);
}

export async function hasGreetingAudio(): Promise<boolean> {
  return (await kvGet(AUDIO_KEY)) !== null;
}

export async function getGreetingAudioInfo(): Promise<{ hasAudio: boolean; fileName: string | null }> {
  const b64 = await kvGet(AUDIO_KEY);
  if (!b64) return { hasAudio: false, fileName: null };
  return { hasAudio: true, fileName: await kvGet(NAME_KEY) };
}
