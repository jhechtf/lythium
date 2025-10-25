
import { browser } from '$app/environment'
/**
 * 
 * @param keybind Should turn generic keybindings into platform specific keybindings.
 * i.e. "ctrl+k" should map to "ctrl+k" on windows, but "meta+k" on Mac
 * @returns 
 */
export function generateSpecificKeybinds(keybind: string) {
  const keyparts = keybind.split('+');

  let os: 'macos' | 'windows' | 'linux' = 'linux';

  if(!browser) return keybind;

  if(navigator.userAgent.includes("Macintosh")) {os = 'macos';}

  return '';
}
