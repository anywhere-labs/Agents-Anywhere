import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";

export default createMiddleware(routing);

export const config = {
  matcher: [
    "/((?!auth|oauth|admin|health|agents|approvals|connectors|pairing|sessions|connector|_next|_vercel|.*\\..*).*)"
  ]
};
