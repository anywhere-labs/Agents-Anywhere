# MeshCall Router for the AA v3 stack, taken from the prebuilt npm binary (static Go, no libc needed).
FROM node:22-alpine AS fetch
ARG MESHCALL_VERSION=0.4.0
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac; \
    cd /tmp && npm pack --silent "meshcall-router-linux-${arch}@${MESHCALL_VERSION}" >/dev/null; \
    tar -xzf meshcall-router-linux-*.tgz; \
    install -m 0755 package/bin/meshcall-router /meshcall-router; \
    /meshcall-router -version

FROM scratch
COPY --from=fetch /meshcall-router /meshcall-router
USER 65532:65532
EXPOSE 8765
ENTRYPOINT ["/meshcall-router"]
CMD ["-host", "0.0.0.0", "-port", "8765"]
