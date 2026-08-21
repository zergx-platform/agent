# syntax=docker/dockerfile:1
# Base images default to the in-cluster Zot registry (buildkitd trusts it as
# an insecure registry); override with --build-arg when building elsewhere.
ARG REGISTRY=rucoder-zot.temp.10.199.64.20.nip.io
FROM ${REGISTRY}/node:26-alpine AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=localhost,127.0.0.1,.svc.cluster.local,.svc,.nip.io
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY scripts scripts
COPY packages packages
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts \
    && npm rebuild esbuild \
    && npm run build

FROM ${REGISTRY}/node:26-alpine
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules node_modules
COPY --from=build /build/packages packages
ENV NODE_ENV=production \
    RUCODER_PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "packages/server/dist/index.js"]
