const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

function applySystemTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark)
}

/**
 * Keep Element Plus' class-based dark theme aligned with the operating system.
 * Returns a cleanup hook for tests and non-app consumers.
 */
export function installSystemTheme(): () => void {
  const media = window.matchMedia(SYSTEM_DARK_QUERY)
  const onChange = (event: MediaQueryListEvent): void => applySystemTheme(event.matches)

  applySystemTheme(media.matches)
  media.addEventListener('change', onChange)

  return () => media.removeEventListener('change', onChange)
}
