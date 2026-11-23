/**
 * @vitest-environment jsdom
 *
 * GH #436: two avatars showing the same logo (the account page header and the
 * Edit dialog) must both get its framing. The second used to see the first's
 * cached answer and skip updating, so it kept the white tile.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/lib/accounts/logo-tile", () => ({ chooseLogoTile: () => ({ kind: "bleed" }) }));

import { AccountAvatar } from "@/components/accounts/account-logo";

afterEach(cleanup);

describe("AccountAvatar framing", () => {
  it("every avatar of the same logo picks up the framing", () => {
    // jsdom has no canvas: give the avatar a minimal 2D context.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    } as unknown as CanvasRenderingContext2D);
    const { container } = render(
      <>
        <AccountAvatar accountId={7} name="Card" logoVersion={1} />
        <AccountAvatar accountId={7} name="Card" logoVersion={1} />
      </>,
    );
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      Object.defineProperty(img, "naturalWidth", { value: 60 });
      Object.defineProperty(img, "naturalHeight", { value: 60 });
      fireEvent.load(img);
    }
    for (const img of Array.from(container.querySelectorAll("img"))) {
      expect(img.className).toContain("object-cover");
      expect(img.parentElement?.className).not.toContain("bg-white");
    }
  });
});
