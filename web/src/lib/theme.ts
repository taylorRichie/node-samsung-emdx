export const ACCENT_THEMES = [
  { id: "default", label: "Paper", swatch: "hsl(40 22% 93%)" },
  { id: "yellow", label: "Yellow", swatch: "hsl(47.9 95.8% 53.1%)" },
  { id: "orange", label: "Orange", swatch: "hsl(24.6 95% 53.1%)" },
  { id: "red", label: "Red", swatch: "hsl(0 72.2% 50.6%)" },
  { id: "rose", label: "Rose", swatch: "hsl(346.8 77.2% 49.8%)" },
  { id: "violet", label: "Violet", swatch: "hsl(263.4 70% 50.4%)" },
  { id: "blue", label: "Blue", swatch: "hsl(217.2 91.2% 59.8%)" },
  { id: "green", label: "Green", swatch: "hsl(142.1 76.2% 36.3%)" },
] as const

export function loadTheme(): string {
  try { return localStorage.getItem("emdx-theme") || "default" }
  catch { return "default" }
}

export function applyTheme(id: string) {
  if (id === "default") document.documentElement.removeAttribute("data-theme")
  else document.documentElement.setAttribute("data-theme", id)
}

export function saveTheme(id: string) {
  applyTheme(id)
  try { localStorage.setItem("emdx-theme", id) } catch { /* private window */ }
}
