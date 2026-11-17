# MeshCall Router built from a pinned commit of github.com/t4wefan/meshcall.
# main 9334405 (#69: tokens with instance_ids, renew/revoke and 4401 close codes) has no release yet;
# the Server's meshcall Python dependency is pinned to the same commit (server/pyproject.toml).
ARG GO_IMAGE=golang:1.26-bookworm
FROM ${GO_IMAGE} AS build
ARG GOPROXY=https://proxy.golang.org,direct
ARG MESHCALL_REF=93344059ada65735c6cc08fdf3247ea9fb808d6b
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/t4wefan/meshcall.git \
 && git fetch -q --depth 1 origin "${MESHCALL_REF}" && git checkout -q FETCH_HEAD
WORKDIR /src/meshcall-router
RUN GOPROXY=${GOPROXY} go mod download
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=dev-${MESHCALL_REF}" \
    -o /meshcall-router ./cmd/meshcall-router

FROM scratch
COPY --from=build /meshcall-router /meshcall-router
USER 65532:65532
EXPOSE 8765
ENTRYPOINT ["/meshcall-router"]
CMD ["--host", "0.0.0.0", "--port", "8765"]
