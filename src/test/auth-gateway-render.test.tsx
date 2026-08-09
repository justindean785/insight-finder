/**
 * The access gateway's auth paths, asserted against the REAL component.
 *
 * Why this exists: `ui-command-center-contract.test.ts` had a block named
 * "preserves every authentication and recovery path" whose entire evidence was
 *
 *     expect(auth).toContain("<form onSubmit={signIn}")
 *
 * That is source text. It passes if `signIn` is gutted to a no-op, if the
 * handler never reaches Supabase, if the submit button is detached from the
 * form, or if the page throws on mount. A redesign that large needs a gate that
 * can actually fail — the point of the rewrite was that the auth surface keeps
 * working, and only a render can establish that.
 *
 * Convention follows `case-report-exclusion.test.tsx`: `createRoot` + `act`
 * rather than @testing-library/react, which is how this repo renders components
 * under test.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// `vi.mock` is hoisted above every top-level const, so the spies have to be
// created inside `vi.hoisted` or the factory closes over a TDZ binding.
const { signInWithPassword, signUpFn, resetPasswordForEmail, unsubscribe } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(async (..._a: unknown[]) => ({ error: null })),
  signUpFn: vi.fn(async (..._a: unknown[]) => ({ error: null })),
  resetPasswordForEmail: vi.fn(async (..._a: unknown[]) => ({ error: null })),
  unsubscribe: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe } } }),
      signInWithPassword,
      signUp: signUpFn,
      resetPasswordForEmail,
      signInWithOAuth: async () => ({ error: null }),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

vi.mock("@/lib/oauth-preflight", () => ({
  probeOAuthProvider: async () => ({ ok: true }),
}));

import Auth from "@/pages/Auth";

let container: HTMLDivElement;
let root: Root;

const mount = () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/auth"]}>
        <Auth />
      </MemoryRouter>,
    );
  });
};

/** Set a controlled input's value the way React's onChange expects. */
const type = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const byId = <T extends HTMLElement>(id: string) =>
  container.querySelector<T>(`#${id}`);

const submitOf = (el: HTMLElement) => {
  const form = el.closest("form")!;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  signInWithPassword.mockClear();
  signUpFn.mockClear();
  resetPasswordForEmail.mockClear();
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("access gateway — the page actually renders", () => {
  it("mounts without throwing and shows the product identity", () => {
    expect(container.textContent).toContain("Insight Finder");
    expect(container.querySelector("form")).not.toBeNull();
  });
});

describe("access gateway — sign-in path reaches Supabase with what was typed", () => {
  it("submits the typed credentials", () => {
    const email = byId<HTMLInputElement>("signin-email")!;
    const password = byId<HTMLInputElement>("signin-password")!;
    expect(email).not.toBeNull();
    expect(password).not.toBeNull();

    type(email, "analyst@example.com");
    type(password, "correct horse battery");
    submitOf(email);

    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "analyst@example.com",
      password: "correct horse battery",
    });
  });

  it("wires the submit button to the sign-in form", () => {
    // A detached button is invisible to a source-text check and fatal in use.
    const form = byId<HTMLInputElement>("signin-email")!.closest("form")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();
    expect(submit!.textContent).toMatch(/sign in/i);
  });
});

describe("access gateway — recovery path", () => {
  it("reveals the reset form and submits the typed email", () => {
    const forgot = Array.from(container.querySelectorAll("button")).find((b) =>
      /forgot password/i.test(b.textContent ?? ""),
    );
    expect(forgot).toBeDefined();
    act(() => forgot!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const reset = byId<HTMLInputElement>("reset-email");
    expect(reset).not.toBeNull();

    type(reset!, "locked-out@example.com");
    submitOf(reset!);

    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect(resetPasswordForEmail.mock.calls[0][0]).toBe("locked-out@example.com");
  });

  it("can return to sign in without a reload", () => {
    const forgot = Array.from(container.querySelectorAll("button")).find((b) =>
      /forgot password/i.test(b.textContent ?? ""),
    )!;
    act(() => forgot.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const back = Array.from(container.querySelectorAll("button")).find((b) =>
      /back to sign in/i.test(b.textContent ?? ""),
    );
    expect(back).toBeDefined();
    act(() => back!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(byId("signin-email")).not.toBeNull();
    expect(byId("reset-email")).toBeNull();
  });
});

describe("access gateway — inputs stay labeled and autofill-aware", () => {
  it("gives every rendered credential input a real <label>", () => {
    // The signup fields live in an unmounted tab panel, so assert over what is
    // actually rendered rather than over ids that may not be in the DOM yet.
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      const label = container.querySelector(`label[for="${input.id}"]`);
      const named = label?.textContent?.trim() || input.getAttribute("aria-label");
      expect(named, `input #${input.id} has no accessible name`).toBeTruthy();
      expect(input.getAttribute("autocomplete")).toBeTruthy();
    }
  });

  it("uses the correct autocomplete token on the sign-in password", () => {
    expect(byId("signin-password")!.getAttribute("autocomplete")).toBe("current-password");
  });
});

describe("access gateway — focus rings keep their offset", () => {
  // The redesign dropped ring-offset from four controls. Without the offset the
  // ring sits flush on the surface and is hard to see.
  //
  // Scanning only the default view is NOT enough, and mutation testing proved
  // it: two of the four sites (the reset form's controls) live behind
  // `forgotMode`, so removing their offset changed nothing observable and the
  // mutation survived. Both states are scanned.
  const assertAllRingsOffset = (where: string) => {
    const ringed = Array.from(
      container.querySelectorAll<HTMLElement>("[class*='focus-visible:ring-2']"),
    );
    expect(ringed.length, `no focus-ring elements found in ${where}`).toBeGreaterThan(0);
    for (const el of ringed) {
      expect(
        el.className,
        `missing ring-offset in ${where}: ${el.className}`,
      ).toContain("focus-visible:ring-offset-");
    }
  };

  const enterForgotMode = () => {
    const forgot = Array.from(container.querySelectorAll("button")).find((b) =>
      /forgot password/i.test(b.textContent ?? ""),
    )!;
    act(() => forgot.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };

  it("offsets every focus ring in the sign-in view", () => {
    assertAllRingsOffset("sign-in view");
  });

  it("offsets every focus ring in the password-recovery view", () => {
    enterForgotMode();
    expect(byId("reset-email"), "recovery view did not render").not.toBeNull();
    assertAllRingsOffset("recovery view");
  });
});

describe("access gateway — legal links survive the redesign", () => {
  it("links to terms and privacy", () => {
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/terms");
    expect(hrefs).toContain("/privacy");
  });
});
