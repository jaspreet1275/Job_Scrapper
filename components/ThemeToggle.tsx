"use client";

import { useEffect, useState } from "react";

// Sun / moon button that flips data-theme on <html> and persists to
// localStorage. The pre-hydration script in layout.tsx handles the
// initial paint so there's no flash; this component just owns the
// runtime toggle.

type Theme = "light" | "dark";

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "dark" ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  // Sync state with whatever the layout script set on <html>. Useful
  // when the toggle mounts after the page has been open for a while.
  useEffect(() => {
    setTheme(readInitialTheme());
  }, []);

  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* localStorage unavailable — runtime state still flips */
    }
  };

  return (
    <button
      type="button"
      onClick={flip}
      className="theme-toggle"
      title={
        theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
      }
      aria-label="Toggle color theme"
    >
      {theme === "dark" ? (
        // Sun icon — shown when dark is active, click to go light
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        // Moon icon — shown when light is active, click to go dark
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
