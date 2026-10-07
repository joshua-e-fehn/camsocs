import { afterEach } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

/**
 * The DOM that component tests render into (salo-ba webapp/test/setup.ts).
 *
 * ⚠ Guarded: `bun test --watch` re-runs the preload, and registering twice
 * throws.
 *
 * ⚠ The `url` is not cosmetic. happy-dom defaults `window.location` to
 * `about:blank`, and Better Auth's client resolves its base URL from
 * `window.location` at module scope — so with the default, merely importing
 * `lib/auth-client.ts` throws `TypeError: Invalid URL`.
 *
 * ⚠ The fetch primitives stay native. happy-dom replaces `fetch`, `Request`,
 * `Response`, `Headers` and `FormData` with *browser* implementations that
 * silently drop forbidden headers such as `Cookie` and `Set-Cookie`. The code
 * under test that uses them (the `/api/auth/*` proxy hop, Convex HTTP actions
 * through convex-test) runs on a server, where those headers are the whole
 * point — with happy-dom's versions the cookie assertions in
 * lib/auth-forwarded-headers.test.ts fail for a harness reason.
 */
if (typeof globalThis.document === "undefined") {
  const native = {
    fetch: globalThis.fetch,
    Request: globalThis.Request,
    Response: globalThis.Response,
    Headers: globalThis.Headers,
    FormData: globalThis.FormData,
  }
  GlobalRegistrator.register({ url: "http://localhost:3000" })
  Object.assign(globalThis, native)
}

/** Every test starts on an empty page; `bun:test` exposes no global hook for
 * Testing Library's automatic cleanup, so it is done by hand. */
afterEach(() => {
  document.body.innerHTML = ""
})
