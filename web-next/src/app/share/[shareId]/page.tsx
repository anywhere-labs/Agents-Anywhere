import { PublicSessionShare } from "@/components/session/public-session-share"

export default async function SharePage({
  params,
}: {
  params: Promise<{ shareId: string }>
}) {
  const { shareId } = await params
  return <PublicSessionShare shareId={shareId} />
}
