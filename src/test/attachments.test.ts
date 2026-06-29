import { describe, it, expect } from "vitest";
import { parseUserMessage, isImageAttachment } from "@/lib/attachments";

// Mirrors the composer output and the screenshot that showed a raw signed URL.
const SIGNED = "https://skzqwbyvmwqarfgfvyky.supabase.co/storage/v1/object/sign/chat-uploads/abc/img.png?token=eyJhbGciOiJIUzI1NiJ9.payload.sig";

describe("parseUserMessage", () => {
  it("returns plain text unchanged when there are no attachments", () => {
    expect(parseUserMessage("riley.brooks@example.com")).toEqual({
      body: "riley.brooks@example.com",
      attachments: [],
    });
  });

  it("splits body from a single attachment and captures the full url", () => {
    const text = `investigate this\n\nAttached files:\n- [Screenshot 2026.png](${SIGNED}) (image/png, 1.2 MB)`;
    const r = parseUserMessage(text);
    expect(r.body).toBe("investigate this");
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]).toMatchObject({ name: "Screenshot 2026.png", url: SIGNED, meta: "image/png, 1.2 MB" });
  });

  it("parses an attachments-only message (no body)", () => {
    const text = `Attached files:\n- [a.pdf](https://x/a.pdf) (application/pdf, 50 KB)\n- [b.png](https://x/b.png) (image/png, 4 KB)`;
    const r = parseUserMessage(text);
    expect(r.body).toBe("");
    expect(r.attachments.map((a) => a.name)).toEqual(["a.pdf", "b.png"]);
  });

  it("ignores non-attachment lines after the marker", () => {
    const r = parseUserMessage("Attached files:\nnot a real line\n- [x.png](https://x/x.png) (image/png, 1 KB)");
    expect(r.attachments).toHaveLength(1);
  });
});

describe("isImageAttachment", () => {
  it("detects images by extension (even with a query string) or mime", () => {
    expect(isImageAttachment({ name: "x.png", url: SIGNED, meta: "" })).toBe(true);
    expect(isImageAttachment({ name: "photo.JPEG", url: "u", meta: "" })).toBe(true);
    expect(isImageAttachment({ name: "file", url: "u", meta: "image/webp, 1 KB" })).toBe(true);
  });
  it("treats non-images as files", () => {
    expect(isImageAttachment({ name: "report.pdf", url: "u", meta: "application/pdf, 2 MB" })).toBe(false);
    expect(isImageAttachment({ name: "data.json", url: "u", meta: "" })).toBe(false);
  });
});
