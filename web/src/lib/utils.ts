import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** The address this page was opened on, when that's a real network address */
export function addressFromBrowser() {
  return /^(localhost|127\.|\[)/.test(window.location.hostname) ? "" : window.location.hostname
}
