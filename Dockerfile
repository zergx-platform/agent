# syntax=docker/dockerfile:1
# Base images default to the in-cluster artifact registry (buildkitd trusts it
# as an insecure registry); override with --build-arg when building elsewhere.
ARG REGISTRY=rucoder-artifact.temp.10.199.64.20.nip.io
FROM ${REGISTRY}/node:26-alpine AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=localhost,127.0.0.1,.svc.cluster.local,.svc,.nip.io
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json .npmrc ./
COPY scripts scripts
COPY packages packages
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts \
    && npm rebuild esbuild \
    && npm run build

# The binary embeds Node, all JS dependencies and the SPA; the runtime stage
# needs only libc + CA certs.
FROM ${REGISTRY}/alpine:3.24
RUN apk add --no-cache ca-certificates libstdc++
COPY --from=build /build/.sea/rucoder-agent /usr/local/bin/rucoder-agent
ENV RUCODER_PORT=8080
EXPOSE 8080
ENTRYPOINT ["rucoder-agent"]
