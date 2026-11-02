import { SiteFrame } from "./site-frame"

/** The public site's frame around every public page (site-frame.tsx). */
export default function SiteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SiteFrame>{children}</SiteFrame>
}
