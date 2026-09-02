import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OverlayProvider } from "@/context/OverlayContext";
import { Sheet } from "./Sheet";

describe("Sheet", () => {
  it("has dialog semantics and closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <OverlayProvider>
        <Sheet open title="Cài đặt" onClose={onClose}>
          <button type="button">Một tùy chọn</button>
        </Sheet>
      </OverlayProvider>,
    );
    expect(screen.getByRole("dialog", { name: "Cài đặt" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses from the backdrop", async () => {
    const onClose = vi.fn();
    render(
      <OverlayProvider>
        <Sheet open title="Mục lục" onClose={onClose}>
          Nội dung
        </Sheet>
      </OverlayProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Đóng nền" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
