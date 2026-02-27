"use client";
import { useEffect, useState } from "react";

export function useDarkMode() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initial = stored ? stored === "dark" : prefersDark;
    setIsDark(initial);
    document.documentElement.classList.toggle("dark", initial);
  }, []);

  const toggle = () => {
    setIsDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      localStorage.setItem("theme", next ? "dark" : "light");
      return next;
    });
  };

  return { isDark, toggle };
}
