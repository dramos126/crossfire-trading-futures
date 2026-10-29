import type { MetadataRoute } from "next";
import icon192 from "./_brand/icon-192.png";
import icon512 from "./_brand/icon-512.png";
import iconSvg from "./_brand/crossfire-icon.svg";

/**
 * The web app manifest, so a phone's "add to home screen" gets the mark at
 * the two sizes Android asks for, plus the vector (Safari reads
 * `apple-icon.png` beside `layout.tsx` instead). The files are imported, not
 * served from `public/`, because the Dockerfile copies only
 * `.next/standalone` and `.next/static` into the image — a static import
 * lands in the latter.
 *
 * No `display` key: the app stays a browser tab when added to a home screen,
 * so the address bar and the back button are still there.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Crossfire Trading",
    short_name: "Crossfire",
    // `--background` and `--sidebar` in globals.css; the manifest cannot read a token.
    background_color: "#0B0F1A",
    theme_color: "#070A13",
    icons: [
      { src: icon192.src, sizes: `${icon192.width}x${icon192.height}`, type: "image/png" },
      { src: icon512.src, sizes: `${icon512.width}x${icon512.height}`, type: "image/png" },
      { src: iconSvg.src, sizes: "any", type: "image/svg+xml" },
    ],
  };
}
