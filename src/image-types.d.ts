// `next build` and `next dev` write next-env.d.ts with this reference, and that
// file is git-ignored, so on a fresh clone `tsc --noEmit` cannot type the image
// imports in app/manifest.ts until a build has run. The same reference, tracked.
/// <reference types="next/image-types/global" />
