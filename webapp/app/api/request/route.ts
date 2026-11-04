import { checkBotId } from "botid/server"
import { fetchMutation } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { handleRequestSubmit } from "@/lib/request-submit"

/**
 * `POST /api/request`: the public request form's submission, checked by Vercel
 * BotID before it reaches `listingRequests.submit` (ENG-37). The flow, the
 * fail-open rules and the secret are in lib/request-submit.ts.
 */
export async function POST(request: Request): Promise<Response> {
  return await handleRequestSubmit(request, {
    checkBot: () => checkBotId(),
    submit: (args) => fetchMutation(api.listingRequests.submit, args),
    env: process.env,
  })
}
