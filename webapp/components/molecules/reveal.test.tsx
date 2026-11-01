import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"
import { Reveal } from "./reveal"

/** UI audit 2026-10-31: `Reveal` shipped `opacity:0` in the server HTML, so
 * half the home page was blank without JavaScript. */
describe("Reveal", () => {
  test("server HTML is plain, visible content", () => {
    const html = renderToString(
      <Reveal className="grid">
        <p>Formals, bops and Bumps</p>
      </Reveal>,
    )
    expect(html).toContain("Formals, bops and Bumps")
    expect(html).toContain('data-reveal="static"')
    expect(html).not.toMatch(/opacity:\s*0/)
    expect(html).not.toContain("transform")
  })
})
