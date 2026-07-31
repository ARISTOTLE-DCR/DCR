const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function uploadPonsImage(sourceUrl: string, uploadUrl: string): Promise<string> {
  const sourceAddress = new URL(sourceUrl);
  if (sourceAddress.protocol !== "https:" || sourceAddress.hostname !== "pbs.twimg.com") {
    throw new ImageUploadError("Attached image must come from X's image CDN.");
  }
  const source = await fetch(sourceAddress, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!source.ok) throw new Error(`Could not download attached image (${source.status}).`);
  const type = source.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
  if (!ALLOWED_TYPES.has(type)) throw new Error("Attached image must be PNG, JPEG, or WebP.");
  const declared = Number(source.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error("Attached image exceeds the 5 MB limit.");
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Attached image exceeds the 5 MB limit.");

  const form = new FormData();
  form.append("image", new Blob([bytes], { type }), fileName(type));
  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000)
  });
  if (!uploaded.ok) throw new Error(`PONS image upload failed (${uploaded.status}).`);
  const payload = await uploaded.json() as { uri?: unknown };
  if (typeof payload.uri !== "string" || !payload.uri.startsWith("ipfs://")) {
    throw new Error("PONS image upload did not return an IPFS URI.");
  }
  return payload.uri;
}

export class ImageUploadError extends Error {}

function fileName(type: string): string {
  if (type === "image/png") return "token.png";
  if (type === "image/webp") return "token.webp";
  return "token.jpg";
}
