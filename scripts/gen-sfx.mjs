// Synthesizes Vybe's built-in sound-effect library into public/sfx/*.mp3.
// Everything is generated from math with ffmpeg's aevalsrc / anoisesrc — no
// samples, so there's nothing to license. Re-run after changing a recipe:
//   node scripts/gen-sfx.mjs
// Keys and durations must stay in sync with src/lib/sfx-library.ts.
import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ffmpeg = require("@ffmpeg-installer/ffmpeg").path;
const out = path.join(process.cwd(), "public", "sfx");
mkdirSync(out, { recursive: true });

// [key, duration, filtergraph source]. `t` is seconds, 44.1 kHz mono.
const SFX = [
  // Airy swoosh: band-limited noise that swells and fades.
  ["whoosh", 0.7, `anoisesrc=color=pink:d=0.7:a=0.9,highpass=f=350,lowpass=f=3800,afade=t=in:d=0.32:curve=qsin,afade=t=out:st=0.32:d=0.38:curve=qsin,volume=3.2`],
  // Deep cinematic boom: falling-pitch sine with an exponential tail + a click.
  ["boom", 1.3, `aevalsrc='0.95*sin(2*PI*(70*t-12*t*t))*exp(-3.2*t)+0.35*(random(0)*2-1)*exp(-60*t)':d=1.3:s=44100`],
  // Short punchy hit for zoom-ins.
  ["hit", 0.45, `aevalsrc='0.9*sin(2*PI*(120*t-60*t*t))*exp(-9*t)+0.5*(random(0)*2-1)*exp(-45*t)':d=0.45:s=44100,lowpass=f=5000`],
  // Bubble pop.
  ["pop", 0.16, `aevalsrc='0.9*sin(2*PI*(500+2600*t)*t)*exp(-32*t)':d=0.16:s=44100`],
  // Bright notification ding (fundamental + octave).
  ["ding", 1.2, `aevalsrc='0.55*(sin(2*PI*1320*t)+0.45*sin(2*PI*2640*t)+0.2*sin(2*PI*3960*t))*exp(-3.4*t)':d=1.2:s=44100`],
  // Tension riser: rising tone + noise that builds then cuts.
  ["riser", 2.0, `aevalsrc='(0.35*sin(2*PI*(180*t+260*t*t))+0.25*(random(0)*2-1))*(t/2)^1.6':d=2:s=44100,highpass=f=150,afade=t=out:st=1.92:d=0.08`],
  // Digital glitch: chopped noise + square buzz.
  ["glitch", 0.45, `aevalsrc='0.55*((random(0)*2-1)*0.6+0.4*(2*gt(sin(2*PI*180*t),0)-1))*gt(sin(2*PI*22*t),-0.2)':d=0.45:s=44100,afade=t=out:st=0.35:d=0.1`],
  // Camera shutter click.
  ["click", 0.14, `aevalsrc='0.9*(random(0)*2-1)*(exp(-70*t)+0.6*exp(-70*(t-0.06))*gt(t,0.06))':d=0.14:s=44100,highpass=f=1200`],
  // Cartoon "boing".
  ["boing", 0.7, `aevalsrc='0.7*sin(2*PI*220*t*(1+0.25*exp(-3*t))+6*sin(2*PI*9*t))*exp(-4*t)':d=0.7:s=44100`],
];

for (const [key, d, src] of SFX) {
  const file = path.join(out, `${key}.mp3`);
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", src,
    "-t", String(d), "-ac", "1", "-ar", "44100",
    // Peak-normalize-ish so every effect sits at a similar loudness.
    "-af", "alimiter=limit=0.9:level=disabled,volume=0.9",
    "-c:a", "libmp3lame", "-b:a", "128k", file,
  ]);
  console.log("✓", key);
}
