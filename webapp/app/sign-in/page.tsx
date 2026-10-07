import { LoginForm } from "@/components/organisms/login-form"
import { PublicHeader } from "@/components/organisms/public-header"

export default function SignInPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <PublicHeader />
      <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <LoginForm />
        </div>
      </div>
    </div>
  )
}
