// Server-safe: the inline <head> script that applies the saved theme before
// the first paint (no dark→light flash). See lib/theme.ts for the hook.
export const THEME_KEY = "vybe-theme";
export const THEME_INIT_SCRIPT =
  `try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==="light")document.documentElement.classList.add("light")}catch(e){}`;
