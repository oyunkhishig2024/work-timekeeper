import type { MetadataRoute } from "next";

/** Lets the admin app be installed; iOS delivers Web Push only to an installed web app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Timekeeper Work",
    short_name: "Timekeeper",
    start_url: "/notifications",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0f766e",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
