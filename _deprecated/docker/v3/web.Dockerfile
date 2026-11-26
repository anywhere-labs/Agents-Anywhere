# web-v3 (Next.js standalone). Build from the repository root:
#   docker build -f docker/v3/web.Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY web-v3/package.json web-v3/.yarnrc.yml ./
RUN yarn install
COPY web-v3/ ./
# Rewrites are fixed at build time: the browser calls /api/control/*, Next forwards it to the control plane.
ARG AA_CONTROL_SERVER_URL=http://control:8080
ENV AA_CONTROL_SERVER_URL=$AA_CONTROL_SERVER_URL NEXT_TELEMETRY_DISABLED=1
RUN yarn build && mkdir -p public

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
