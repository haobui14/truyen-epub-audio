import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionButton, IconButton } from "./Button";

describe("shared buttons", () => {
  it("exposes an accessible name and 44px target for icon actions", async () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Phát" onClick={onClick}>
        <span aria-hidden="true">▶</span>
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Phát" });
    expect(button).toHaveClass("size-11");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("announces loading and prevents duplicate actions", () => {
    render(<ActionButton loading>Đang lưu</ActionButton>);
    const button = screen.getByRole("button", { name: "Đang lưu" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});

